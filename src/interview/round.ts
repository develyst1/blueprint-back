// One interview round (SPEC-A-003 § Interview round + § Round decisions). The model never writes the spec and never
// picks a stamp: the server turns its answer into one change set, stamped here, applied through REQ-001's store.
import { and, desc, eq, gt, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { messages, projects, sources } from "../db/schema";
import type { ChatMessage, ChatResult, Gateway } from "../gateway/client";
import { type Call, modelFor, type Weight } from "../gateway/models";
import { NotFound, ValidationError } from "../spec/errors";
import { isApiPath, LINK_KINDS, PART_KINDS, type PartKind } from "../spec/registry";
import { applyChangeSet, loadSpec } from "../spec/store";
import { computeStuck } from "../spec/stuck";
import type { Change, Link, Origin, Part } from "../spec/types";
import { buildRequest, HISTORY, MODEL_KINDS, optionalField, shapeOf } from "./context";
import { parseReply, type ModelReply } from "./protocol";

export const MAX_MESSAGE_CHARS = 20_000;
export const MAX_ACCEPT = 20;
export const MAX_NEW_QUESTIONS = 5;
export const MAX_CONTRADICTIONS = 5;
export const MAX_BETWEEN = 10;
export const MIN_QUOTE_CHARS = 10;
// Addendum A (SPEC-A-003, TASK-A-033): answers in the user's own words and parked questions, per round.
export const MAX_ANSWERS = 20;
export const MAX_ANSWER_CHARS = 2_000;
export const MAX_PARK = 20;
export const MAX_PARK_REASON_CHARS = 500;
export const MAX_SUGGESTIONS = 5;
const PROTECTED = new Set(["operator", "customer-asked", "customer-validated"]);

export type RoundStatus = "applied" | "no_changes" | "changes_rejected" | "bot_could_not_answer";
// SPEC-105 E2: why a round was rejected. `unknown_kind`: a part/link kind the server does not accept · `needs_user_words`: the
// provenance guard · `invalid_change`: any other refusal · `protocol`: the correction was not the JSON.
export type RejectReason = "unknown_kind" | "needs_user_words" | "invalid_change" | "protocol";
export const MAX_NOTE_CHARS = 60;
// SPEC-105 E6: one model item the server did not store. `depends_on_refused`: it names the `$ref` of an item that was refused.
export type ItemReason = "unknown_kind" | "needs_user_words" | "invalid_change" | "depends_on_refused";
export const MAX_REFUSED = 50;
export const MAX_RAW_CHARS = 4000;
// SPEC-105 E8/E9: what the server changed in an item it stored. `ref_renamed` (from → to) · `body_defaulted` (a part.add with no
// body) · `wrapped_in_list` (field: a string where a list of strings goes) · `field_dropped` (field: an optional field that was wrong).
// E11: `op_renamed` (from `type` → to `op`): a change that carried its op under `type`.
export type Adjusted = { item: string; what: "ref_renamed" | "body_defaulted" | "wrapped_in_list" | "field_dropped" | "op_renamed" | "url_kept"; field?: string; from?: string; to?: string };
// E14: `url_kept`: an address the user wrote that no part held, stored by the server as an `api` part (`item` = `server:url <n>`).
// …as recorded: with `title` / `key` / `ref` of the stored item, exactly as a `round_refused` entry has them, so a line can name the part.
export type AdjustedEntry = Adjusted & { title: string | null; key: string | null; ref: string | null };
export type AdjustedRecord = (AdjustedEntry | { item: "more"; count: number })[];
export const MAX_TITLE_CHARS = 80;
export const MAX_DETAIL_CHARS = 200;
type Refused = {
  item: string; op: string | null; kind: string | null; ref: string | null; key: string | null; title: string | null;
  reason: ItemReason; detail: string; note?: string; // `note` feeds the round's summary code only; it is not stored per item
};
/** What the bot row and the Round response carry: the first 50 refused items, then `{ item: "more", count }` for the rest. */
export type RefusedRecord = (Omit<Refused, "note"> | { item: "more"; count: number })[];
export type Round = {
  status: RoundStatus; reply: string | null; changeSetId: string | null;
  questions: string[]; contradictions: string[]; failedSources: string[]; messageIds: string[];
  /** REQ-110: `changes_rejected` → a RejectReason (reply is null); `bot_could_not_answer` → the gateway's reason; else null. */
  reason: string | null; note: string | null;
  /** REQ-110 round 2: every model item not stored (the reply is then null); null when nothing was refused. */
  refused: RefusedRecord | null; saved: number | null; // saved = model items stored, set with `refused`
  /** REQ-110 round 3: what the server adjusted in the items it stored; null when nothing. */
  adjusted: AdjustedRecord | null;
  /** REQ-115 (SPEC-112 G4): every gateway call of the round, in order; null when the round made none. */
  calls: Call[] | null;
};
export type RoundInput = {
  message?: string; accept?: string[];
  answers?: { key: string; text: string }[]; park?: { key: string; reason?: string }[];
  /** D-023 (TASK-A-037): ask the bot again for the newest turn, whose bot could not answer. Alone, never with another field. */
  retry?: boolean;
};

/** `{ retry: true }` when the newest turn's bot did not fail (or there is no turn) — 409 nothing_to_retry. */
export class NothingToRetry extends Error {
  constructor() { super("the newest turn has no failed bot answer to retry"); this.name = "NothingToRetry"; }
}

const NO_REPLY: ModelReply = { reply: "", changes: [], questions: [], contradictions: [], suggestions: [] };
export type Message = {
  id: string; role: "user" | "bot" | "caw"; content: string; model: string; creativity: number;
  roundStatus: string | null; changeSetId: string | null; createdAt: string;
  roundReason: string | null; roundNote: string | null; // REQ-110; null on every row that is not a failed bot row
  roundRefused: RefusedRecord | null; // REQ-110 round 2; null unless the server dropped something of the model's answer
  roundSaved: number | null; // …and how many model items it did store in that round; null exactly when roundRefused is
  roundAdjusted: AdjustedRecord | null; // REQ-110 round 3; null unless the server adjusted a stored item
  roundRaw: string | null; // REQ-110 round 3: the first 4000 chars of a reply the server could not read; for the team, not the UI
  roundCalls: Call[] | null; // REQ-115: the gateway calls of the round that wrote this bot row; null on other rows and on older ones
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
// Question de-duplication only (TASK-A-025 step 5): Thai has no spaces between words, so spacing must not make a
// question "new". Quotes in the provenance guard keep using `norm` — strict is the safe side there.
const sameQuestionKey = (s: string) => s.replace(/\s+/g, "").toLowerCase();
const tidy = (s: string) => s.trim().replace(/\s+/g, " ");
// Ranking of new questions by what they are about: work, step, screen, api, any other kind, then none.
const ABOUT_RANK: Record<string, number> = { work: 0, step: 1, screen: 2, api: 3 };

type SourceRow = { id: string; name: string; status: string; reason: string | null; text: string | null; origin: unknown };
type Refusal = { error: string; reason: RejectReason; note?: string };
// `invalid`: nothing of the model's answer could be stored (the refusals are in `refused`) · `applied.refused` is what was left out.
type Applied =
  | { status: "applied"; changeSetId: string; questions: string[]; contradictions: string[]; botRowId: string; refused: RefusedRecord | null; saved: number | null; adjusted: AdjustedRecord | null }
  | { status: "no_changes"; contradictions: string[] }
  | ({ status: "invalid"; refused: Refused[] } & Refusal);

// Messages are ordered by `created_at`, and the clock can give two rows the same millisecond (seen: 171 of 200
// quick pairs). So a new row is always stamped strictly after the project's newest message — the order is exact.
async function nextMessageTime(db: Db, projectId: string, after?: Date): Promise<Date> {
  const [latest] = await db.select({ at: messages.createdAt }).from(messages)
    .where(eq(messages.projectId, projectId)).orderBy(desc(messages.createdAt)).limit(1);
  const floor = Math.max(latest?.at.getTime() ?? 0, after?.getTime() ?? 0) + 1;
  return new Date(Math.max(Date.now(), floor));
}

async function requireProject(db: Db, projectId: string) {
  if (!UUID_RE.test(projectId)) throw new NotFound("project");
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!p) throw new NotFound("project");
  return p;
}

// SPEC-105 E5: the answer → the REQ-001 changes the server can store, stamped by the server (SPEC steps 1–4), plus every model
// item it could not. Each model item (`changes[i]`, `questions[k]`, `contradictions[k]`, `suggestions[i]`) is checked on its own;
// an item that is refused is left out together with every item that names its `$ref`. `item` says where an entry came from, so
// a refusal — or the store's own `ValidationError(index)` — can be mapped back to the model's item. `server:…` items are the
// user's own decisions and are never dropped.
type Entry = { item: string; change: Change };
type Plan = {
  entries: Entry[]; refused: Refused[]; adjusted: Adjusted[];
  questionRefs: { item: string; ref: string }[]; contradictionRefs: { item: string; ref: string }[];
};
const isServer = (e: Entry) => e.item.startsWith("server:");
// The `$ref`s a change names (a link's ends, an update's or removal's key): what it cannot be stored without.
const namesOf = (c: Change): string[] =>
  [(c as { key?: unknown }).key, (c as { from?: unknown }).from, (c as { to?: unknown }).to]
    .filter((v): v is string => typeof v === "string" && v.startsWith("$"));
const short = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
function describe(item: string, change: Record<string, unknown>, reason: ItemReason, detail: string,
  extra: { note?: string; ref?: string | null } = {}): Refused {
  return {
    item, op: short(change.op, 40), kind: short(change.kind, 40), ref: extra.ref !== undefined ? extra.ref : short(change.ref, 40),
    key: short(change.key, 40), title: short(change.title, MAX_TITLE_CHARS), reason, detail: detail.slice(0, MAX_DETAIL_CHARS),
    ...(extra.note !== undefined ? { note: extra.note.slice(0, MAX_NOTE_CHARS) } : {}),
  };
}
// Drops every item that names a dead `$ref`, and the refs those items defined, until nothing more names one.
function cascade(entries: Entry[], dead: Set<string>): { kept: Entry[]; dropped: Refused[] } {
  let kept = entries;
  const dropped: Refused[] = [];
  for (;;) {
    const hit = kept.find((e) => !isServer(e) && namesOf(e.change).some((r) => dead.has(r)));
    if (!hit) return { kept, dropped };
    const via = namesOf(hit.change).find((r) => dead.has(r))!;
    const gone = kept.filter((e) => e.item === hit.item);
    kept = kept.filter((e) => e.item !== hit.item);
    dropped.push(describe(hit.item, gone[0]!.change as Record<string, unknown>, "depends_on_refused", `needs ${via}, which was not saved`, { ref: via }));
    for (const e of gone) if (e.change.op === "part.add") dead.add(e.change.ref);
  }
}
// SPEC-105 E6 `round_saved`: the model items (changes / questions / contradictions) that are in the set; the user's own
// decisions, suggestions and the link rows of one item are not counted.
const savedItems = (entries: Entry[]) => new Set(entries.filter((e) => /^(changes|questions|contradictions)\[/.test(e.item)).map((e) => e.item)).size;
// What was adjusted in the items that are in the set (an item that was refused or dropped afterwards leaves no trace here).
function adjustedRecord(adjusted: Adjusted[], entries: Entry[], keys: Record<string, string> = {}): AdjustedRecord | null {
  const stored = new Set(entries.map((e) => e.item));
  const named = (a: Adjusted): AdjustedEntry => {
    const c = (entries.find((e) => e.item === a.item)?.change ?? {}) as Record<string, unknown>;
    const { item, what, ...rest } = a;
    // a `url_kept` part is added by the server, so its key is the one the store gave its `$ref`
    const key = a.what === "url_kept" && typeof c.ref === "string" ? short(keys[c.ref], 40) : short(c.key, 40);
    return { item, what, title: short(c.title, MAX_TITLE_CHARS), key, ref: short(c.ref, 40), ...rest };
  };
  const kept = adjusted.filter((a) => stored.has(a.item)).map(named);
  if (kept.length === 0) return null;
  return kept.length > MAX_REFUSED ? [...kept.slice(0, MAX_REFUSED), { item: "more", count: kept.length - MAX_REFUSED }] : kept;
}
function toRecord(refused: Refused[]): RefusedRecord {
  const shown = refused.slice(0, MAX_REFUSED).map(({ note: _note, ...item }) => item);
  return refused.length > MAX_REFUSED ? [...shown, { item: "more", count: refused.length - MAX_REFUSED }] : shown;
}

// SPEC-105 E8: repair only what has one reading, before anything is validated, and say what was repaired. (a) a `$ref` with
// characters other than letters, digits and `_` → each run of them becomes `_`, the same way everywhere that ref appears in this
// answer; two different refs that would become equal are both left alone (they fail as before). (b) a part.add with no body → {}.
// (c) a string where the kind's body wants a list of strings → a list of that string. Nothing else is coerced.
const REF_OK = /^\$[A-Za-z0-9_]+$/;
const defType = (schema: unknown) => (schema as { def: { type: string; innerType?: unknown; element?: unknown } }).def;
function isStringList(schema: unknown): boolean {
  const def = defType(schema);
  if (def.type === "optional" || def.type === "default") return isStringList(def.innerType);
  return def.type === "array" && defType(def.element).type === "string";
}
const bodyShape = (kind: unknown) => (typeof kind === "string" && Object.hasOwn(PART_KINDS, kind) ? shapeOf(PART_KINDS[kind as PartKind].body as never) : null);
function repair(answer: ModelReply, live: Map<string, Part>): { answer: ModelReply; adjusted: Adjusted[] } {
  const adjusted: Adjusted[] = [];
  const changes = answer.changes.map((it) => ({ ...it, change: { ...it.change } as Record<string, unknown> }));
  // (a)
  const target = (r: string) => (REF_OK.test(r) ? r : `$${r.slice(1).replace(/[^A-Za-z0-9_]+/g, "_")}`);
  const defined = new Map<string, string>(); // each distinct `$ref` a part.add defines → the item that defines it
  for (const [i, it] of changes.entries()) {
    const r = it.change.ref;
    if (it.change.op === "part.add" && typeof r === "string" && r.length > 1 && r.startsWith("$") && !defined.has(r)) defined.set(r, `changes[${i}]`);
  }
  const becomes = new Map<string, Set<string>>();
  for (const r of defined.keys()) becomes.set(target(r), (becomes.get(target(r)) ?? new Set()).add(r));
  const renamed = new Map<string, string>();
  for (const [r, item] of defined) {
    const to = target(r);
    if (to !== r && becomes.get(to)!.size === 1) { renamed.set(r, to); adjusted.push({ item, what: "ref_renamed", from: r, to }); }
  }
  const sub = (v: unknown) => (typeof v === "string" && renamed.has(v) ? renamed.get(v)! : v);
  if (renamed.size > 0) {
    for (const it of changes) for (const f of ["ref", "from", "to", "key"]) if (f in it.change) it.change[f] = sub(it.change[f]);
  }
  const questions = renamed.size > 0 ? answer.questions.map((q) => ({ ...q, about: q.about === undefined ? undefined : (sub(q.about) as string) })) : answer.questions;
  const contradictions = renamed.size > 0 ? answer.contradictions.map((c) => ({ ...c, between: c.between.map((b) => sub(b) as string) })) : answer.contradictions;
  // (b), (c)
  for (const [i, it] of changes.entries()) {
    const c = it.change;
    if (c.op === "part.add" && c.body === undefined) { c.body = {}; adjusted.push({ item: `changes[${i}]`, what: "body_defaulted" }); }
    if ((c.op === "part.add" || c.op === "part.update") && c.body && typeof c.body === "object" && !Array.isArray(c.body)) {
      const shape = bodyShape(c.op === "part.add" ? c.kind : live.get(String(c.key))?.kind);
      if (!shape) continue;
      const body = { ...(c.body as Record<string, unknown>) };
      for (const [field, schema] of Object.entries(shape)) {
        if (typeof body[field] === "string" && isStringList(schema)) { body[field] = [body[field]]; adjusted.push({ item: `changes[${i}]`, what: "wrapped_in_list", field }); }
      }
      c.body = body;
    }
  }
  return { answer: { ...answer, changes: changes as unknown as ModelReply["changes"], questions, contradictions }, adjusted };
}

// SPEC-105 E9: if a body fails only on optional or defaulted top-level fields, those fields are removed and the rest is kept;
// the removed names come back. Any other failure (a required field, an unknown field) → null, and the item is refused as before.
function withoutBadOptionals(kind: unknown, body: unknown): { body: Record<string, unknown>; dropped: string[] } | null {
  const shape = bodyShape(kind);
  if (!shape || !body || typeof body !== "object" || Array.isArray(body)) return null;
  const schema = PART_KINDS[kind as PartKind].body;
  const first = schema.safeParse(body);
  if (first.success) return null;
  const dropped = new Set<string>();
  for (const issue of first.error.issues) {
    const field = issue.path[0];
    if (issue.code === "unrecognized_keys" || typeof field !== "string" || !shape[field] || !optionalField(shape[field])) return null;
    dropped.add(field);
  }
  const rest = Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([k]) => !dropped.has(k)));
  return schema.safeParse(rest).success ? { body: rest, dropped: [...dropped] } : null;
}

// SPEC-111 E14: the http(s) addresses in the user's message that need a server item — not held by a non-question part, either
// live or in the entries kept so far (a question's text does not hold one). Trailing `.,;:!?` stripped, only what `isApiPath`
// accepts, deduplicated, at most MAX_URLS. The caller numbers each with the lowest `$url_<n>` not yet used in this attempt's entries.
// SPEC-113 E15: an address is ASCII URL characters only, so Thai text glued to it ends it. E16: "held" means the same address
// (set membership on the form without a trailing `/`), not a substring.
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/g;
const MAX_URLS = 20;
const noSlash = (u: string) => u.replace(/\/+$/, "");
const stripped = (text: string) => [...text.matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
const addressesIn = (text: string) => stripped(text).map(noSlash);
function uncaughtUrls(message: string | undefined, live: Part[], entries: Entry[]): string[] {
  if (!message) return [];
  const all = [...new Set(stripped(message).filter(isApiPath))].slice(0, MAX_URLS);
  if (all.length === 0) return [];
  const kindOf = new Map(live.map((p) => [p.key, p.kind as string]));
  for (const e of entries) if (e.change.op === "part.add") kindOf.set(e.change.ref, e.change.kind);
  const held = live.filter((p) => p.kind !== "question").map((p) => `${p.title} ${JSON.stringify(p.body)}`);
  for (const { change: c } of entries) {
    if (c.op === "part.add" && c.kind !== "question") held.push(`${c.title} ${JSON.stringify(c.body ?? {})}`);
    else if (c.op === "part.update" && kindOf.get(c.key) !== "question") held.push(`${c.title ?? ""} ${JSON.stringify(c.body ?? {})}`);
  }
  const same = new Set(addressesIn(held.join("\n")));
  return all.filter((url) => !same.has(noSlash(url)));
}

function build(raw: ModelReply, ctx: {
  parts: Part[]; links: Link[]; sources: SourceRow[]; today: string; message?: string;
  accepted: { part: Part; proposedAnswer: string }[];
  answered: { part: Part; text: string }[]; parked: { part: Part; reason?: string }[];
}): Plan {
  const live = new Map(ctx.parts.map((p) => [p.key, p]));
  const { answer, adjusted } = repair(raw, live);
  // A quote counts only from 10 characters, normalised (rule 2, TASK-A-023): shorter words occur by chance.
  const found = (quote: string | undefined, text: string | undefined | null) =>
    !!quote && norm(quote).length >= MIN_QUOTE_CHARS && text != null && norm(text).includes(norm(quote));
  const isProtected = (key: unknown) => typeof key === "string" && PROTECTED.has(live.get(key)?.origin.stamp ?? "");
  const operator: Origin = { stamp: "operator", date: ctx.today };
  const guess: Origin = { stamp: "team-proposed", date: ctx.today };
  const entries: Entry[] = ctx.accepted.map(({ part, proposedAnswer }) => ({
    item: `server:accept ${part.key}`,
    change: { op: "part.update", key: part.key, body: { ...part.body, status: "answered", answer: proposedAnswer }, origin: operator },
  }));
  const refused: Refused[] = [];
  // Addendum A: A-R1 an answer in the user's own words (operator, like accept) · A-R3 park (origin unchanged).
  for (const { part, text } of ctx.answered) {
    entries.push({ item: `server:answer ${part.key}`, change: { op: "part.update", key: part.key, body: { ...part.body, status: "answered", answer: text }, origin: operator } });
  }
  for (const { part, reason } of ctx.parked) {
    entries.push({ item: `server:park ${part.key}`, change: { op: "part.update", key: part.key, body: { ...part.body, status: "parked", ...(reason ? { parkedReason: reason } : {}) } } });
  }
  // A-R2: the user's own words = this round's message plus every answer text.
  const ownWords = [ctx.message ?? "", ...ctx.answered.map((a) => a.text)].join("\n");

  const refKinds = new Map<string, string>();
  const dead = new Set<string>(); // `$ref`s of part.adds that were refused
  const asked: { text: string; proposedAnswer: string; cases: string[]; about?: string; item: string }[] = [];
  for (const [i, item] of answer.changes.entries()) {
    const id = `changes[${i}]`;
    // Provenance guard: the server only ever lowers a stamp (rules 2, 3). `userSaid` = a quote of this round's message.
    const userSaid = item.saidBy === "user" && found(item.quote, ownWords);
    const change = { ...item.change } as Record<string, unknown>;
    // One refusal per item: the first rule it breaks. Rule 4: allowed ops and kinds · rule 5: parts stamped operator/customer-*
    // need the user's own words.
    const problem = ((): { why: string; reason?: ItemReason; note?: string } | null => {
      if (item.saidBy !== "user" && item.saidBy !== "inferred") {
        const sourceId = item.saidBy.source;
        if (!ctx.sources.some((s) => s.id === sourceId && s.status === "read")) {
          return { why: `saidBy names "${sourceId}", which is not a read source of this project` };
        }
      }
      if (!item.sure && !item.ifUnsure) return { why: "sure is false but ifUnsure is missing" };
      if (!item.sure) return null; // not applied: it becomes a question (AC-7)
      if (change.op === "part.add" && !MODEL_KINDS.has(String(change.kind))) {
        return { why: `a ${String(change.kind)} cannot be added as a change — use questions / contradictions`, reason: "unknown_kind", note: String(change.kind) };
      }
      if (change.op === "link.add" && !Object.hasOwn(LINK_KINDS, String(change.kind))) {
        return { why: `unknown link kind "${String(change.kind)}"`, reason: "unknown_kind", note: String(change.kind) };
      }
      if (change.op === "part.update") {
        const target = live.get(String(change.key));
        if (target && !MODEL_KINDS.has(target.kind)) return { why: `a ${target.kind} cannot be changed here — use accept or a new question` };
        if (isProtected(change.key) && !userSaid) return { why: `${String(change.key)} was stated by a person; changing it needs the user's own words (quote)`, reason: "needs_user_words" };
      }
      if (change.op === "part.remove" && !userSaid) return { why: "removing a part needs the user's own words (quote)", reason: "needs_user_words" };
      if (change.op === "link.remove") {
        const link = ctx.links.find((l) => l.id === change.id);
        if (link && (isProtected(link.fromKey) || isProtected(link.toKey)) && !userSaid) {
          return { why: "this link touches a part stated by a person; removing it needs the user's own words (quote)", reason: "needs_user_words" };
        }
      }
      if (!["part.add", "part.update", "part.remove", "link.add", "link.update", "link.remove"].includes(String(change.op))) {
        return { why: `unknown op "${String(change.op)}"` };
      }
      return null;
    })();
    if (problem) {
      refused.push(describe(id, change, problem.reason ?? "invalid_change", problem.why, { note: problem.note }));
      if (change.op === "part.add" && typeof change.ref === "string") dead.add(change.ref);
      continue;
    }
    if (!item.sure) {
      asked.push({ ...item.ifUnsure!, item: id });
      continue;
    }
    let origin: Origin;
    if (item.saidBy === "user") origin = userSaid ? operator : guess;
    else if (item.saidBy === "inferred") origin = guess;
    else {
      const sourceId = item.saidBy.source;
      const src = ctx.sources.find((s) => s.id === sourceId && s.status === "read")!;
      const from = src.origin as Origin;
      origin = !found(item.quote, src.text)
        ? { ...guess, sourceId: src.id }
        : from.stamp === "customer-validated" // a sentence lifted from a document is never the customer's yes
          ? { stamp: "customer-asked", date: ctx.today, ...(from.channel ? { channel: from.channel } : {}), sourceId: src.id }
          : { ...from, date: ctx.today, sourceId: src.id };
    }
    if (change.op === "part.add" || change.op === "link.add" || change.op === "part.update") change.origin = origin;
    if (change.op === "part.add" || change.op === "part.update") {
      const fixed = withoutBadOptionals(change.op === "part.add" ? change.kind : live.get(String(change.key))?.kind, change.body);
      if (fixed) {
        change.body = fixed.body;
        for (const field of fixed.dropped) adjusted.push({ item: id, what: "field_dropped", field });
      }
    }
    entries.push({ item: id, change: change as Change });
  }
  // Items that name the ref of a refused part.add go with it (transitively).
  const pruned = cascade(entries, dead);
  refused.push(...pruned.dropped);
  entries.splice(0, entries.length, ...pruned.kept);
  for (const e of entries) if (e.change.op === "part.add") refKinds.set(e.change.ref, e.change.kind);

  const known = (key: string) => live.has(key) || refKinds.has(key);
  // A question or contradiction side that points at a part: fine, or why this item cannot be stored.
  const pointsAt = (key: string, side: string): { reason: ItemReason; detail: string; ref: string | null } | null =>
    dead.has(key) ? { reason: "depends_on_refused", detail: `needs ${key}, which was not saved`, ref: key }
      : known(key) ? null : { reason: "invalid_change", detail: `${side} "${key}" is not a part or a $ref of this answer`, ref: null };
  const existing = new Set(ctx.parts.filter((p) => p.kind === "question").map((p) => sameQuestionKey(String(p.body.text ?? p.title))));
  const kept: typeof asked = [];
  for (const q of [...asked, ...answer.questions.map((q, k) => ({ ...q, item: `questions[${k}]` }))]) {
    const refuse = (reason: ItemReason, detail: string, ref: string | null = null) =>
      refused.push({ item: q.item, op: "part.add", kind: "question", ref, key: null, title: short(tidy(q.text), MAX_TITLE_CHARS) || null, reason, detail: detail.slice(0, MAX_DETAIL_CHARS) });
    if (!q.text.trim()) { refuse("invalid_change", "a question has no text"); continue; }
    if (!q.proposedAnswer.trim()) { refuse("invalid_change", "proposedAnswer is empty"); continue; }
    const bad = q.about !== undefined ? pointsAt(q.about, "about") : null;
    if (bad) { refuse(bad.reason, bad.detail, bad.ref); continue; }
    const n = sameQuestionKey(q.text);
    if (existing.has(n)) continue; // already asked (AC-4)
    existing.add(n);
    kept.push(q);
  }
  const kindOf = (q: { about?: string }) => (q.about === undefined ? 5 : ABOUT_RANK[live.get(q.about)?.kind ?? refKinds.get(q.about) ?? ""] ?? 4);
  const ranked = kept.map((q, i) => ({ q, i })).sort((a, b) => kindOf(a.q) - kindOf(b.q) || a.i - b.i).slice(0, MAX_NEW_QUESTIONS);

  const questionRefs: Plan["questionRefs"] = [];
  for (const [j, { q }] of ranked.entries()) {
    const ref = `$srvq${j + 1}`;
    questionRefs.push({ item: q.item, ref });
    const text = tidy(q.text); // stored trimmed, inner spaces collapsed (step 5)
    entries.push({ item: q.item, change: { op: "part.add", ref, kind: "question", title: text,
      body: { text, proposedAnswer: q.proposedAnswer, cases: q.cases, status: "open" }, origin: guess } });
    if (q.about !== undefined) entries.push({ item: q.item, change: { op: "link.add", kind: "about", from: ref, to: q.about, origin: guess } });
  }

  // A contradiction whose sides equal an OPEN one's (this spec's, or one added earlier in this answer) is not stored
  // again; the reply names that part instead (REQ-003 R6, TASK-A-065). Side sets compare order-insensitively.
  const sidesKey = (sides: string[]) => [...new Set(sides)].sort().join("\n");
  const holding = new Map<string, string>();
  for (const p of ctx.parts) {
    if (p.kind !== "contradiction" || p.body.status !== "open") continue;
    holding.set(sidesKey(ctx.links.filter((l) => l.kind === "conflicts" && l.fromKey === p.key).map((l) => l.toKey)), p.key);
  }
  const contradictionRefs: Plan["contradictionRefs"] = [];
  const definedBy = new Map<string, string>(); // `$srvc` ref → the item that adds it, so a repeat in this answer lives or dies with it
  // Rule 6: at most 5 contradictions per round, each between at most 10 keys (the rest is not stored).
  for (const [k, c] of answer.contradictions.slice(0, MAX_CONTRADICTIONS).map((c) => ({ ...c, between: c.between.slice(0, MAX_BETWEEN) })).entries()) {
    const item = `contradictions[${k}]`;
    const refuse = (reason: ItemReason, detail: string, ref: string | null = null) =>
      refused.push({ item, op: "part.add", kind: "contradiction", ref, key: null, title: short(c.note, MAX_TITLE_CHARS), reason, detail: detail.slice(0, MAX_DETAIL_CHARS) });
    if (c.between.length === 0) { refuse("invalid_change", "between is empty"); continue; }
    const bad = c.between.map((b) => pointsAt(b, "between")).find((b) => b !== null);
    if (bad) { refuse(bad.reason, bad.detail, bad.ref); continue; }
    if (c.sourceId !== undefined && !ctx.sources.some((s) => s.id === c.sourceId)) {
      refuse("invalid_change", `sourceId "${c.sourceId}" is not a source of this project`);
      continue;
    }
    const same = holding.get(sidesKey(c.between));
    if (same !== undefined) { contradictionRefs.push({ item: definedBy.get(same) ?? item, ref: same }); continue; }
    const ref = `$srvc${k + 1}`;
    holding.set(sidesKey(c.between), ref);
    definedBy.set(ref, item);
    contradictionRefs.push({ item, ref });
    entries.push({ item, change: { op: "part.add", ref, kind: "contradiction", title: c.note, origin: guess, body: {
      note: c.note, ...(c.sourceId ? { sourceId: c.sourceId } : {}), ...(c.quote ? { quote: c.quote } : {}),
    } } });
    for (const b of c.between) entries.push({ item, change: { op: "link.add", kind: "conflicts", from: ref, to: b, origin: guess } });
  }
  // A-R4: a suggestion is kept only for a live open question with no proposed answer that this round does not close.
  // Status and origin stay; the answer is marked as ours. Anything else is dropped silently.
  const closing = new Set([...ctx.accepted, ...ctx.answered, ...ctx.parked].map(({ part }) => part.key));
  const suggested = new Set<string>();
  for (const [i, s] of answer.suggestions.slice(0, MAX_SUGGESTIONS).entries()) {
    const q = live.get(s.key);
    if (!q || q.kind !== "question" || q.body.status !== "open" || String(q.body.proposedAnswer ?? "").trim()) continue;
    if (closing.has(s.key) || suggested.has(s.key) || !s.proposedAnswer.trim()) continue;
    suggested.add(s.key);
    entries.push({ item: `suggestions[${i}]`, change: { op: "part.update", key: s.key, body: { ...q.body, proposedAnswer: s.proposedAnswer.trim(), proposedAnswerStamp: "team-proposed" } } });
  }
  return { entries, refused, adjusted, questionRefs, contradictionRefs };
}

// The turn a retry re-asks: the newest user row, whose newest bot row after it is bot_could_not_answer.
async function retryTarget(db: Db, projectId: string) {
  const [user] = await db.select().from(messages).where(and(eq(messages.projectId, projectId), eq(messages.role, "user")))
    .orderBy(desc(messages.createdAt)).limit(1);
  if (!user) throw new NothingToRetry();
  const [bot] = await db.select({ roundStatus: messages.roundStatus }).from(messages)
    .where(and(eq(messages.projectId, projectId), eq(messages.role, "bot"), gt(messages.createdAt, user.createdAt)))
    .orderBy(desc(messages.createdAt)).limit(1);
  if (bot?.roundStatus !== "bot_could_not_answer") throw new NothingToRetry();
  return user;
}

export async function runRound(db: Db, gateway: Gateway, projectId: string,
  input: RoundInput, opts: { today: string; by?: string }): Promise<Round> {
  const project = await requireProject(db, projectId);
  const retry = input.retry === true;
  if (retry && [input.message, input.accept, input.answers, input.park].some((v) => v !== undefined)) {
    throw new ValidationError(null, "retry: send it alone — it asks the bot again for the turn that failed");
  }
  const accept = input.accept ?? [];
  const answers = input.answers ?? [];
  const park = input.park ?? [];
  if (!retry && input.message === undefined && accept.length === 0 && answers.length === 0 && park.length === 0) {
    throw new ValidationError(null, "give a message, questions to accept, answers, questions to park, or a mix");
  }
  if (input.message !== undefined && input.message.length > MAX_MESSAGE_CHARS) {
    throw new ValidationError(null, `message: at most ${MAX_MESSAGE_CHARS} characters`);
  }
  if (accept.length > MAX_ACCEPT) throw new ValidationError(null, `accept: at most ${MAX_ACCEPT} questions`);
  const twice = accept.findIndex((k, i) => accept.indexOf(k) !== i);
  if (twice >= 0) throw new ValidationError(twice, `accept: ${accept[twice]} is listed twice`);
  // Addendum A: answers and park, checked before anything is written or called.
  if (answers.length > MAX_ANSWERS) throw new ValidationError(null, `answers: at most ${MAX_ANSWERS}`);
  if (park.length > MAX_PARK) throw new ValidationError(null, `park: at most ${MAX_PARK}`);
  for (const [i, a] of answers.entries()) {
    if (!a.text.trim() || a.text.length > MAX_ANSWER_CHARS) throw new ValidationError(i, `answers: text must be 1–${MAX_ANSWER_CHARS} characters`);
    if (a.text.includes("\u0000")) throw new ValidationError(i, "answers: text contains a NUL character");
  }
  for (const [i, p] of park.entries()) {
    if (p.reason !== undefined && p.reason.length > MAX_PARK_REASON_CHARS) throw new ValidationError(i, `park: reason is at most ${MAX_PARK_REASON_CHARS} characters`);
    if (p.reason?.includes("\u0000")) throw new ValidationError(i, "park: reason contains a NUL character");
  }
  // A key may appear once, in one list only.
  const seen = new Map<string, string>();
  for (const [list, keys] of [["accept", accept], ["answers", answers.map((a) => a.key)], ["park", park.map((p) => p.key)]] as const) {
    for (const [i, key] of keys.entries()) {
      const where = seen.get(key);
      if (where) throw new ValidationError(i, `${list}: ${key} is already listed in ${where}`);
      seen.set(key, list);
    }
  }

  // A retry re-asks the failed turn with its own user row: its words are the message (A-036: message + answers), and
  // its decisions are already in (D-023 kept them when the bot failed) — no new user row, nothing re-applied.
  const retried = retry ? await retryTarget(db, projectId) : null;
  const message = retried ? retried.content : input.message;

  const spec = await loadSpec(db, projectId);
  // Accepted questions are checked before anything is written or called.
  const accepted = accept.map((key, i) => {
    const part = spec.parts.find((p) => p.key === key);
    const proposedAnswer = String(part?.body.proposedAnswer ?? "");
    if (!part || part.kind !== "question" || part.body.status !== "open" || !proposedAnswer.trim()) {
      throw new ValidationError(i, `accept: ${key} is not an open question with a proposed answer`);
    }
    return { part, proposedAnswer };
  });
  const openQuestion = (list: string, key: string, i: number) => {
    const part = spec.parts.find((p) => p.key === key);
    if (!part || part.kind !== "question" || part.body.status !== "open") throw new ValidationError(i, `${list}: ${key} is not an open question`);
    return part;
  };
  const ownAnswers = answers.map((a, i) => ({ part: openQuestion("answers", a.key, i), text: a.text }));
  const parked = park.map((p, i) => ({ part: openQuestion("park", p.key, i), reason: p.reason }));

  const srcRows: SourceRow[] = await db.select({
    id: sources.id, name: sources.name, status: sources.status, reason: sources.reason, text: sources.text, origin: sources.origin,
  }).from(sources).where(eq(sources.projectId, projectId)).orderBy(sources.createdAt);
  const failedSources = srcRows.filter((s) => s.status === "failed").map((s) => s.id);

  // The user's row first: its id is the change set's cause.
  const [userRow] = retried ? [retried] : await db.insert(messages).values({
    // The user's own words: the message, then each answer (TASK-A-036). Accept-only and park-only rounds stay "".
    projectId, role: "user", content: [input.message ?? "", ...answers.map((a) => a.text)].filter((t) => t !== "").join("\n"),
    model: project.model, creativity: project.creativity, by: opts.by ?? null,
    createdAt: await nextMessageTime(db, projectId),
  }).returning();
  // Everything before this turn (for a retry, the failed bot rows after its user row are not history).
  const history = (await db.select({ role: messages.role, content: messages.content }).from(messages)
    .where(and(eq(messages.projectId, projectId), lt(messages.createdAt, userRow!.createdAt)))
    .orderBy(desc(messages.createdAt)).limit(HISTORY)).reverse() as { role: "user" | "bot"; content: string }[];

  let appliedChangeSet: string | null = null;
  const calls: Call[] = []; // REQ-115 G4: every gateway call of this round, in order
  const callsOrNull = () => (calls.length > 0 ? [...calls] : null);
  try {
  const request = buildRequest({
    parts: spec.parts, links: spec.links, stuck: computeStuck(spec), history, message,
    sources: srcRows.map((s) => ({ id: s.id, name: s.name, status: s.status, reason: s.reason ?? undefined, text: s.text ?? undefined })),
    accepted: accepted.map(({ part, proposedAnswer }) => ({ key: part.key, text: String(part.body.text ?? part.title), proposedAnswer })),
    answered: ownAnswers.map(({ part, text }) => ({ key: part.key, text })),
  });

  // `stored` = what the bot row keeps as `round_reason` / `round_note` (REQ-110): the gateway's reason for a bot that could not
  // answer, a RejectReason (+ note) for a rejected round. `reason` is only the codes-only log line below. `refused` = the
  // model items left out of a round that was rejected whole (an applied round's come with `applied`).
  const finish = async (status: RoundStatus, reply: string | null, model: string,
    applied?: Extract<Applied, { status: "applied" }>, reason?: string, stored?: { reason: string; note?: string }, refused: Refused[] = [],
    raw?: string): Promise<Round> => {
    // Rule 7: a codes-only line for the two failure outcomes — never a prompt, a reply or document text.
    if (status === "bot_could_not_answer" || status === "changes_rejected") console.error(`[round] ${status} reason=${reason ?? "unknown"}`);
    const record = applied ? applied.refused : refused.length > 0 ? toRecord(refused) : null;
    const saved = applied ? applied.saved : record ? 0 : null; // a round rejected whole stored no model item
    // An applied round's bot row was written inside its change-set transaction (TASK-A-023); every other one here.
    const botRowId = applied?.botRowId ?? (await db.insert(messages).values({
      projectId, role: "bot", content: reply ?? "", model, creativity: project.creativity,
      roundStatus: status, changeSetId: null, createdAt: await nextMessageTime(db, projectId, userRow!.createdAt),
      roundReason: stored?.reason ?? null, roundNote: stored?.note ?? null, roundRefused: record, roundSaved: saved, roundRaw: raw ?? null, roundCalls: callsOrNull(),
    }).returning())[0]!.id;
    return {
      status, reply, changeSetId: applied?.changeSetId ?? null,
      questions: applied?.questions ?? [], contradictions: applied?.contradictions ?? [],
      failedSources, messageIds: [userRow!.id, botRowId], calls: callsOrNull(),
      reason: stored?.reason ?? null, note: stored?.note ?? null, refused: record, saved, adjusted: applied?.adjusted ?? null,
    };
  };
  // E12: only the round's first call may take the longer first-answer limit; the re-ask and the correction keep the normal one.
  // REQ-115 G2–G4: one call, asked on `model`, and recorded. `readable` says whether the reply is usable (the call's `ok`).
  const ask = async (step: Call["step"], weight: Weight, model: string, messagesToSend: ChatMessage[],
    readable: (content: string) => boolean, opts: { firstAnswer?: boolean; fallback?: boolean } = {}): Promise<ChatResult> => {
    const r = await gateway.chat({ model, creativity: project.creativity, messages: messagesToSend }, ...(opts.firstAnswer ? [{ firstAnswer: true }] as const : []));
    const ok = r.ok && readable(r.content);
    calls.push({ step, weight, asked: model, model: r.ok ? `${r.provider}/${r.model}` : null, fallback: opts.fallback === true, ok,
      reason: r.ok ? (ok ? null : "protocol") : r.reason });
    return r;
  };
  // G3: a light step is asked on the light model; when that call fails, or its reply is `bad`, or (`weak`) it is readable but not
  // good enough, it is asked ONCE more on the project's model — never twice, and never when light IS the project's model.
  const askLight = async (step: Call["step"], messagesToSend: ChatMessage[], judge: (content: string) => "good" | "weak" | "bad") => {
    const asked = modelFor("light", project.model);
    const readable = (c: string) => judge(c) !== "bad";
    const light = await ask(step, "light", asked, messagesToSend, readable);
    if (asked === project.model || (light.ok && judge(light.content) === "good")) return { light };
    return { light, fallback: await ask(step, "light", project.model, messagesToSend, readable, { fallback: true }) };
  };
  const modelOf = (r: { provider: string; model: string }) => `${r.provider}/${r.model}`;
  // `renamed` = the E11 renames of the parse this answer came from; they sit beside E8's in the plan's adjustments.
  const planOf = (answer: ModelReply, renamed: Adjusted[] = []) => {
    const plan = build(answer, { parts: spec.parts, links: spec.links, sources: srcRows, today: opts.today, message,
      accepted, answered: ownAnswers, parked });
    return renamed.length > 0 ? { ...plan, adjusted: [...renamed, ...plan.adjusted] } : plan;
  };

  // `bot` = the bot row written with the set: an answered round, or (D-023) a failed one that still keeps decisions
  // (`carried` = the refused items to record on it). SPEC-105 E5: if the store refuses a change (`ValidationError(index)`) the
  // model item it came from is dropped, with everything that names it, and the rest is applied again — no new gateway call.
  const applyAnswer = async (plan: Plan, botModel: string,
    bot: { status: RoundStatus; reply: string | null; reason?: string; note?: string; raw?: string } = { status: "applied", reply: null },
    carried: Refused[] = []): Promise<Applied> => {
    let entries = plan.entries;
    const adjusted = [...plan.adjusted];
    const refused = [...plan.refused, ...carried];
    // The round's one code, for when nothing of the model's answer is left: the first refusal that was not a knock-on.
    const refusal = (): Refusal => {
      const root = refused.find((r) => r.reason !== "depends_on_refused") ?? refused[0]!;
      const reason: RejectReason = root.reason === "unknown_kind" || root.reason === "needs_user_words" ? root.reason : "invalid_change";
      return { error: `${root.item}: ${root.detail}`, reason, ...(root.note !== undefined ? { note: root.note } : {}) };
    };
    for (;;) {
      // E14: before each attempt, so it also sees the items the last attempt dropped.
      for (const url of uncaughtUrls(message, spec.parts, entries)) {
        const used = new Set(entries.flatMap((e) => (e.change.op === "part.add" ? [e.change.ref] : [])));
        let n = 1;
        while (used.has(`$url_${n}`)) n++;
        const item = `server:url ${n}`;
        entries = [...entries, { item, change: { op: "part.add", kind: "api", ref: `$url_${n}`, title: url.slice(0, MAX_TITLE_CHARS), body: { method: "GET", path: url }, origin: { stamp: "team-proposed", date: opts.today } } }];
        adjusted.push({ item, what: "url_kept" });
      }
      if (bot.status === "applied" && refused.length > 0 && !entries.some((e) => !isServer(e))) return { status: "invalid", ...refusal(), refused };
      if (entries.length === 0) return { status: "no_changes", contradictions: plan.contradictionRefs.filter((r) => !r.ref.startsWith("$")).map((r) => r.ref) };
      try {
        let botRowId = "";
        // The bot row goes in the change set's own transaction: a set never lands without its reply (rule 8).
        const { changeSetId, keys } = await applyChangeSet(db, projectId, { cause: { kind: "message", ref: userRow!.id }, changes: entries.map((e) => e.change) }, {
          by: opts.by, // REQ-103: the change set carries the name of the person who sent the round
          inTx: async (tx, r) => {
            const [botRow] = await tx.insert(messages).values({
              // E5c: when anything was left out, the model's words are not shown (they may call it saved).
              projectId, role: "bot", content: refused.length > 0 ? "" : bot.reply ?? "", model: botModel, creativity: project.creativity,
              roundStatus: bot.status, changeSetId: r.changeSetId, createdAt: await nextMessageTime(tx, projectId, userRow!.createdAt),
              roundReason: bot.reason ?? null, roundNote: bot.note ?? null, roundRefused: refused.length > 0 ? toRecord(refused) : null, roundSaved: refused.length > 0 ? savedItems(entries) : null,
              roundAdjusted: adjustedRecord(adjusted, entries, r.keys), roundRaw: bot.raw ?? null, roundCalls: callsOrNull(),
            }).returning();
            botRowId = botRow!.id;
          },
        });
        appliedChangeSet = changeSetId;
        const keyOf = (r: string) => {
          const key = keys[r];
          if (!key) throw new Error(`integrity: change set ${changeSetId} returned no key for ${r}`);
          return key;
        };
        const stored = new Set(entries.map((e) => e.item));
        return {
          status: "applied", changeSetId, botRowId, refused: refused.length > 0 ? toRecord(refused) : null, saved: refused.length > 0 ? savedItems(entries) : null, adjusted: adjustedRecord(adjusted, entries, keys),
          questions: plan.questionRefs.filter((r) => stored.has(r.item)).map((r) => keyOf(r.ref)),
          contradictions: plan.contradictionRefs.filter((r) => !r.ref.startsWith("$") || stored.has(r.item)).map((r) => (r.ref.startsWith("$") ? keyOf(r.ref) : r.ref)),
        };
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        const bad = e.index === null ? undefined : entries[e.index];
        if (!bad) {
          refused.push({ item: "answer", op: null, kind: null, ref: null, key: null, title: null, reason: "invalid_change", detail: e.message.slice(0, MAX_DETAIL_CHARS) });
          return { status: "invalid", ...refusal(), refused };
        }
        // A change the server made itself (an accepted question) failing is our bug, not the model's: let it be a 500.
        if (isServer(bad)) throw new Error(`integrity: a server-made change was refused (${bad.item}): ${e.message}`);
        const gone = entries.filter((x) => x.item === bad.item);
        refused.push(describe(bad.item, gone[0]!.change as Record<string, unknown>, "invalid_change", e.message));
        const next = cascade(entries.filter((x) => x.item !== bad.item),
          new Set(gone.flatMap((x) => (x.change.op === "part.add" ? [x.change.ref] : []))));
        entries = next.kept;
        refused.push(...next.dropped);
      }
    }
  };

  // D-023: the bot failed, but what the user decided this turn (accept · answers · park) is still applied — one set,
  // caused by the user row, with the failure's bot row. A turn with no decisions changes nothing, as before.
  // E14: an address the server will keep counts as a decision too.
  const decided = accepted.length + ownAnswers.length + parked.length > 0 || uncaughtUrls(message, spec.parts, []).length > 0;
  // REQ-110 E2: a rejected round never shows the model's words (they were written as though the changes would land, so they say
  // "saved"). It keeps a code instead. A bot that could not answer keeps the gateway's reason (E4). `refusal` = the rejected
  // round's code, from the refusal that ended it; `refused` = the model items left out (E6).
  const fail = async (status: "bot_could_not_answer" | "changes_rejected", reply: string | null, model: string, reason: string,
    refusal?: { reason: RejectReason; note?: string }, refused: Refused[] = [], extra: { note?: string; raw?: string } = {}) => {
    const shown = status === "changes_rejected" ? null : reply;
    // E10: a bot that could not answer may carry a note (the later failure) and the raw unreadable reply.
    const stored = status === "changes_rejected" ? (refusal ?? { reason: "invalid_change" as const }) : { reason, ...(extra.note !== undefined ? { note: extra.note } : {}) };
    if (!decided) return finish(status, shown, model, undefined, reason, stored, refused, extra.raw);
    const kept = await applyAnswer(planOf(NO_REPLY), model, { status, reply: shown, reason: stored.reason, ...("note" in stored && stored.note !== undefined ? { note: stored.note } : {}), ...(extra.raw !== undefined ? { raw: extra.raw } : {}) }, refused);
    if (kept.status !== "applied") throw new Error(`integrity: the user's decisions did not apply (${kept.status})`);
    return finish(status, shown, model, kept, reason, stored);
  };

  // A-R3: a round that only parks has nothing to ask — it applies the server's changes with no model call.
  if (message === undefined && accept.length === 0 && answers.length === 0) {
    const parkedOnly = await applyAnswer(planOf(NO_REPLY), project.model);
    if (parkedOnly.status !== "applied") throw new Error(`integrity: a park-only round did not apply (${parkedOnly.status})`);
    return finish("applied", null, project.model, parkedOnly);
  }

  // (1) the round · (2) once more only if (1) is not our protocol · (3) one correction only if the server left items out.
  // A transport failure has already been retried inside the client (R8), so it ends the round.
  const first = await ask("first", "heavy", modelFor("heavy", project.model), request, (c) => parseReply(c).ok, { firstAnswer: true });
  if (!first.ok) return fail("bot_could_not_answer", null, project.model, first.reason);
  let answered = first;
  let parsed = parseReply(first.content);
  if (!parsed.ok) {
    // E10: the reason is the FIRST failure (the reply was not our protocol); a re-ask that also fails goes in the note. The
    // unreadable reply is kept for the team (a NUL cannot be stored in text).
    const raw = first.content.replaceAll("\u0000", "").slice(0, MAX_RAW_CHARS);
    const reasked = await askLight("reask", request, (c) => (parseReply(c).ok ? "good" : "bad"));
    const again = reasked.fallback ?? reasked.light;
    if (!again.ok) return fail("bot_could_not_answer", null, project.model, "protocol", undefined, [], { note: `then ${again.reason}`, raw });
    answered = again;
    parsed = parseReply(again.content);
    if (!parsed.ok) return fail("bot_could_not_answer", null, modelOf(again), "protocol", undefined, [], { raw });
  }

  let plan = planOf(parsed.reply, parsed.adjusted);
  let reply = parsed.reply.reply;
  // Why the correction did not replace the first answer, if it was asked for and failed (E5b): that answer is then pruned and applied.
  let correctionFailed: string | null = null;
  if (plan.refused.length > 0) {
    const named = plan.refused.filter((r) => r.reason !== "depends_on_refused").slice(0, 5).map((r) => `${r.item}: ${r.detail}`).join("; ");
    // G3: the light correction is `weak` when it parses but still leaves items refused.
    const plans = new Map<string, Plan | null>();
    const planFor = (content: string) => {
      if (!plans.has(content)) { const p = parseReply(content); plans.set(content, p.ok ? planOf(p.reply, p.adjusted) : null); }
      return plans.get(content)!;
    };
    const corrected = await askLight("correction", [...request,
      { role: "assistant", content: answered.content },
      { role: "user", content: `The server refused that answer: ${named}. Reply again with the whole JSON, corrected. Nothing was applied.` }],
      (c) => { const p = planFor(c); return p === null ? "bad" : p.refused.length > 0 ? "weak" : "good"; });
    // Transport or unreadable → the fallback's answer (if there is one). Readable but still refusing → the fallback's plan only if
    // it has fewer refused items than the light one's.
    const lightPlan = corrected.light.ok ? planFor(corrected.light.content) : null;
    let correction = corrected.light;
    if (corrected.fallback) {
      const fbPlan = corrected.fallback.ok ? planFor(corrected.fallback.content) : null;
      if (lightPlan === null || (fbPlan !== null && fbPlan.refused.length < lightPlan.refused.length)) correction = corrected.fallback;
    }
    const fixed = correction.ok ? parseReply(correction.content) : null;
    if (correction.ok && fixed?.ok) {
      answered = correction;
      reply = fixed.reply.reply;
      plan = planOf(fixed.reply, fixed.adjusted);
    } else {
      correctionFailed = correction.ok ? "protocol" : correction.reason;
    }
  }
  const result = await applyAnswer(plan, modelOf(answered), { status: "applied", reply });
  if (result.status === "invalid") {
    // Nothing of the answer could be stored. If the correction itself failed on protocol, that is the code; else the refusal's.
    const code = correctionFailed === "protocol" ? { reason: "protocol" as const } : { reason: result.reason, ...(result.note !== undefined ? { note: result.note } : {}) };
    return fail("changes_rejected", reply, modelOf(answered), correctionFailed ?? "validation", code, result.refused);
  }
  // E5c: something stored → applied; when anything was left out the model's reply is not shown (its row says "").
  if (result.status === "applied") return finish("applied", result.refused ? null : reply, modelOf(answered), result);
  // nothing new was stored, but a repeated contradiction still names the part that holds it (TASK-A-065)
  const none = await finish("no_changes", reply, modelOf(answered));
  return { ...none, contradictions: result.contradictions };
  } catch (e) {
    // An unexpected fault (not a normal round outcome): the round never happened, so its user row goes — unless a
    // change set already points at it as its cause (then it stays, for history; SA question Q2).
    // A retry's user row belongs to an earlier turn (and may already cause a set): never delete it here.
    if (appliedChangeSet === null && !retried) await db.delete(messages).where(eq(messages.id, userRow!.id));
    throw e;
  }
}

export async function listMessages(db: Db, projectId: string, limit: number): Promise<Message[]> {
  await requireProject(db, projectId);
  const rows = await db.select().from(messages).where(eq(messages.projectId, projectId)).orderBy(desc(messages.createdAt)).limit(limit);
  return rows.reverse().map((r) => ({
    id: r.id, role: r.role as Message["role"], content: r.content, model: r.model, creativity: r.creativity,
    roundStatus: r.roundStatus, changeSetId: r.changeSetId, createdAt: r.createdAt.toISOString(),
    roundReason: r.roundReason, roundNote: r.roundNote, roundRefused: (r.roundRefused as RefusedRecord | null) ?? null, roundSaved: r.roundSaved,
    roundAdjusted: (r.roundAdjusted as AdjustedRecord | null) ?? null, roundRaw: r.roundRaw,
    roundCalls: (r.roundCalls as Call[] | null) ?? null,
  }));
}
