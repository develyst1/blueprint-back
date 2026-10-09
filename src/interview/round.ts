// One interview round (SPEC-A-003 § Interview round + § Round decisions). The model never writes the spec and never
// picks a stamp: the server turns its answer into one change set, stamped here, applied through REQ-001's store.
import { and, desc, eq, gt, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { messages, projects, sources } from "../db/schema";
import type { ChatMessage, Gateway } from "../gateway/client";
import { NotFound, ValidationError } from "../spec/errors";
import { applyChangeSet, loadSpec } from "../spec/store";
import { computeStuck } from "../spec/stuck";
import type { Change, Link, Origin, Part } from "../spec/types";
import { buildRequest, HISTORY } from "./context";
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
// What the model may change itself (Provenance guard rule 4): questions and contradictions have their own channels.
const MODEL_KINDS = new Set(["work", "step", "interaction", "role", "screen", "api", "system", "data", "decision"]);
const PROTECTED = new Set(["operator", "customer-asked", "customer-validated"]);

export type RoundStatus = "applied" | "no_changes" | "changes_rejected" | "bot_could_not_answer";
export type Round = {
  status: RoundStatus; reply: string | null; changeSetId: string | null;
  questions: string[]; contradictions: string[]; failedSources: string[]; messageIds: string[];
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
// `labels[i]` says where `changes[i]` came from, so a refusal can name the model's own item (or show it was ours).
type Built = { ok: true; changes: Change[]; labels: string[]; questionRefs: string[]; contradictionRefs: string[] } | { ok: false; error: string };
type Applied =
  | { status: "applied"; changeSetId: string; questions: string[]; contradictions: string[]; botRowId: string }
  | { status: "no_changes" }
  | { status: "invalid"; error: string };

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

// The answer → one list of REQ-001 changes, stamped by the server (SPEC steps 1–4). An invalid answer is an error
// string, which goes to the one correction call.
function build(answer: ModelReply, ctx: {
  parts: Part[]; links: Link[]; sources: SourceRow[]; today: string; message?: string;
  accepted: { part: Part; proposedAnswer: string }[];
  answered: { part: Part; text: string }[]; parked: { part: Part; reason?: string }[];
}): Built {
  const live = new Map(ctx.parts.map((p) => [p.key, p]));
  // A quote counts only from 10 characters, normalised (rule 2, TASK-A-023): shorter words occur by chance.
  const found = (quote: string | undefined, text: string | undefined | null) =>
    !!quote && norm(quote).length >= MIN_QUOTE_CHARS && text != null && norm(text).includes(norm(quote));
  const isProtected = (key: unknown) => typeof key === "string" && PROTECTED.has(live.get(key)?.origin.stamp ?? "");
  const operator: Origin = { stamp: "operator", date: ctx.today };
  const guess: Origin = { stamp: "team-proposed", date: ctx.today };
  const out: Change[] = ctx.accepted.map(({ part, proposedAnswer }) => ({
    op: "part.update", key: part.key, body: { ...part.body, status: "answered", answer: proposedAnswer }, origin: operator,
  }));
  const labels: string[] = ctx.accepted.map(({ part }) => `server:accept ${part.key}`);
  // Addendum A: A-R1 an answer in the user's own words (operator, like accept) · A-R3 park (origin unchanged).
  for (const { part, text } of ctx.answered) {
    out.push({ op: "part.update", key: part.key, body: { ...part.body, status: "answered", answer: text }, origin: operator });
    labels.push(`server:answer ${part.key}`);
  }
  for (const { part, reason } of ctx.parked) {
    out.push({ op: "part.update", key: part.key, body: { ...part.body, status: "parked", ...(reason ? { parkedReason: reason } : {}) } });
    labels.push(`server:park ${part.key}`);
  }
  // A-R2: the user's own words = this round's message plus every answer text.
  const ownWords = [ctx.message ?? "", ...ctx.answered.map((a) => a.text)].join("\n");

  const refKinds = new Map<string, string>();
  const asked: { text: string; proposedAnswer: string; cases: string[]; about?: string }[] = [];
  for (const [i, item] of answer.changes.entries()) {
    // Provenance guard: the server only ever lowers a stamp (rules 2, 3). `userSaid` = a quote of this round's message.
    const userSaid = item.saidBy === "user" && found(item.quote, ownWords);
    let origin: Origin;
    if (item.saidBy === "user") origin = userSaid ? operator : guess;
    else if (item.saidBy === "inferred") origin = guess;
    else {
      const id = item.saidBy.source;
      const src = ctx.sources.find((s) => s.id === id && s.status === "read");
      if (!src) return { ok: false, error: `changes[${i}]: saidBy names "${id}", which is not a read source of this project` };
      const from = src.origin as Origin;
      origin = !found(item.quote, src.text)
        ? { ...guess, sourceId: src.id }
        : from.stamp === "customer-validated" // a sentence lifted from a document is never the customer's yes
          ? { stamp: "customer-asked", date: ctx.today, ...(from.channel ? { channel: from.channel } : {}), sourceId: src.id }
          : { ...from, date: ctx.today, sourceId: src.id };
    }
    if (!item.sure) {
      if (!item.ifUnsure) return { ok: false, error: `changes[${i}]: sure is false but ifUnsure is missing` };
      asked.push(item.ifUnsure); // not applied: it becomes a question (AC-7)
      continue;
    }
    const change = { ...item.change } as Record<string, unknown>;
    // Rule 4: allowed ops and kinds · rule 5: parts stamped operator/customer-* need the user's own words.
    const refused = (why: string): Built => ({ ok: false, error: `changes[${i}]: ${why}` });
    if (change.op === "part.add" && !MODEL_KINDS.has(String(change.kind))) {
      return refused(`a ${String(change.kind)} cannot be added as a change — use questions / contradictions`);
    }
    if (change.op === "part.update") {
      const target = live.get(String(change.key));
      if (target && !MODEL_KINDS.has(target.kind)) return refused(`a ${target.kind} cannot be changed here — use accept or a new question`);
      if (isProtected(change.key) && !userSaid) return refused(`${String(change.key)} was stated by a person; changing it needs the user's own words (quote)`);
    }
    if (change.op === "part.remove" && !userSaid) return refused("removing a part needs the user's own words (quote)");
    if (change.op === "link.remove") {
      const link = ctx.links.find((l) => l.id === change.id);
      if (link && (isProtected(link.fromKey) || isProtected(link.toKey)) && !userSaid) {
        return refused("this link touches a part stated by a person; removing it needs the user's own words (quote)");
      }
    }
    if (!["part.add", "part.update", "part.remove", "link.add", "link.update", "link.remove"].includes(String(change.op))) {
      return refused(`unknown op "${String(change.op)}"`);
    }
    if (change.op === "part.add" || change.op === "link.add" || change.op === "part.update") change.origin = origin;
    if (change.op === "part.add" && typeof change.ref === "string") refKinds.set(change.ref, String(change.kind));
    out.push(change as Change);
    labels.push(`changes[${i}]`);
  }

  const known = (key: string) => live.has(key) || refKinds.has(key);
  const existing = new Set(ctx.parts.filter((p) => p.kind === "question").map((p) => sameQuestionKey(String(p.body.text ?? p.title))));
  const kept: typeof asked = [];
  for (const q of [...asked, ...answer.questions]) {
    if (!q.text.trim()) return { ok: false, error: "a question has no text" };
    if (!q.proposedAnswer.trim()) return { ok: false, error: `question "${q.text}": proposedAnswer is empty` };
    if (q.about !== undefined && !known(q.about)) return { ok: false, error: `question "${q.text}": about "${q.about}" is not a part or a $ref of this answer` };
    const n = sameQuestionKey(q.text);
    if (existing.has(n)) continue; // already asked (AC-4)
    existing.add(n);
    kept.push(q);
  }
  const kindOf = (q: { about?: string }) => (q.about === undefined ? 5 : ABOUT_RANK[live.get(q.about)?.kind ?? refKinds.get(q.about) ?? ""] ?? 4);
  const ranked = kept.map((q, i) => ({ q, i })).sort((a, b) => kindOf(a.q) - kindOf(b.q) || a.i - b.i).slice(0, MAX_NEW_QUESTIONS);

  const questionRefs: string[] = [];
  for (const [j, { q }] of ranked.entries()) {
    const ref = `$srvq${j + 1}`;
    questionRefs.push(ref);
    const text = tidy(q.text); // stored trimmed, inner spaces collapsed (step 5)
    out.push({ op: "part.add", ref, kind: "question", title: text,
      body: { text, proposedAnswer: q.proposedAnswer, cases: q.cases, status: "open" }, origin: guess });
    labels.push(`question "${q.text}"`);
    if (q.about !== undefined) {
      out.push({ op: "link.add", kind: "about", from: ref, to: q.about, origin: guess });
      labels.push(`question "${q.text}" (about)`);
    }
  }

  const contradictionRefs: string[] = [];
  // Rule 6: at most 5 contradictions per round, each between at most 10 keys (the rest is not stored).
  for (const [k, c] of answer.contradictions.slice(0, MAX_CONTRADICTIONS).map((c) => ({ ...c, between: c.between.slice(0, MAX_BETWEEN) })).entries()) {
    if (c.between.length === 0) return { ok: false, error: `contradictions[${k}]: between is empty` };
    const unknown = c.between.find((b) => !known(b));
    if (unknown) return { ok: false, error: `contradictions[${k}]: "${unknown}" is not a part or a $ref of this answer` };
    if (c.sourceId !== undefined && !ctx.sources.some((s) => s.id === c.sourceId)) {
      return { ok: false, error: `contradictions[${k}]: sourceId "${c.sourceId}" is not a source of this project` };
    }
    const ref = `$srvc${k + 1}`;
    contradictionRefs.push(ref);
    out.push({ op: "part.add", ref, kind: "contradiction", title: c.note, origin: guess, body: {
      note: c.note, ...(c.sourceId ? { sourceId: c.sourceId } : {}), ...(c.quote ? { quote: c.quote } : {}),
    } });
    labels.push(`contradictions[${k}]`);
    for (const b of c.between) {
      out.push({ op: "link.add", kind: "conflicts", from: ref, to: b, origin: guess });
      labels.push(`contradictions[${k}] (between ${b})`);
    }
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
    out.push({ op: "part.update", key: s.key, body: { ...q.body, proposedAnswer: s.proposedAnswer.trim(), proposedAnswerStamp: "team-proposed" } });
    labels.push(`suggestions[${i}]`);
  }
  return { ok: true, changes: out, labels, questionRefs, contradictionRefs };
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
  input: RoundInput, opts: { today: string }): Promise<Round> {
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
    model: project.model, creativity: project.creativity,
    createdAt: await nextMessageTime(db, projectId),
  }).returning();
  // Everything before this turn (for a retry, the failed bot rows after its user row are not history).
  const history = (await db.select({ role: messages.role, content: messages.content }).from(messages)
    .where(and(eq(messages.projectId, projectId), lt(messages.createdAt, userRow!.createdAt)))
    .orderBy(desc(messages.createdAt)).limit(HISTORY)).reverse() as { role: "user" | "bot"; content: string }[];

  let appliedChangeSet: string | null = null;
  try {
  const request = buildRequest({
    parts: spec.parts, links: spec.links, stuck: computeStuck(spec), history, message,
    sources: srcRows.map((s) => ({ id: s.id, name: s.name, status: s.status, reason: s.reason ?? undefined, text: s.text ?? undefined })),
    accepted: accepted.map(({ part, proposedAnswer }) => ({ key: part.key, text: String(part.body.text ?? part.title), proposedAnswer })),
    answered: ownAnswers.map(({ part, text }) => ({ key: part.key, text })),
  });

  const finish = async (status: RoundStatus, reply: string | null, model: string,
    applied?: Extract<Applied, { status: "applied" }>, reason?: string): Promise<Round> => {
    // Rule 7: a codes-only line for the two failure outcomes — never a prompt, a reply or document text.
    if (status === "bot_could_not_answer" || status === "changes_rejected") console.error(`[round] ${status} reason=${reason ?? "unknown"}`);
    // An applied round's bot row was written inside its change-set transaction (TASK-A-023); every other one here.
    const botRowId = applied?.botRowId ?? (await db.insert(messages).values({
      projectId, role: "bot", content: reply ?? "", model, creativity: project.creativity,
      roundStatus: status, changeSetId: null, createdAt: await nextMessageTime(db, projectId, userRow!.createdAt),
    }).returning())[0]!.id;
    return {
      status, reply, changeSetId: applied?.changeSetId ?? null,
      questions: applied?.questions ?? [], contradictions: applied?.contradictions ?? [],
      failedSources, messageIds: [userRow!.id, botRowId],
    };
  };
  const ask = (messagesToSend: ChatMessage[]) =>
    gateway.chat({ model: project.model, creativity: project.creativity, messages: messagesToSend });
  const modelOf = (r: { provider: string; model: string }) => `${r.provider}/${r.model}`;

  // `bot` = the bot row written with the set: an answered round, or (D-023) a failed one that still keeps decisions.
  const applyAnswer = async (answer: ModelReply, botModel: string,
    bot: { status: RoundStatus; reply: string | null } = { status: "applied", reply: answer.reply }): Promise<Applied> => {
    const built = build(answer, { parts: spec.parts, links: spec.links, sources: srcRows, today: opts.today, message,
      accepted, answered: ownAnswers, parked });
    if (!built.ok) return { status: "invalid", error: built.error };
    if (built.changes.length === 0) return { status: "no_changes" };
    try {
      let botRowId = "";
      // The bot row goes in the change set's own transaction: a set never lands without its reply (rule 8).
      const { changeSetId, keys } = await applyChangeSet(db, projectId, { cause: { kind: "message", ref: userRow!.id }, changes: built.changes }, {
        inTx: async (tx, r) => {
          const [botRow] = await tx.insert(messages).values({
            projectId, role: "bot", content: bot.reply ?? "", model: botModel, creativity: project.creativity,
            roundStatus: bot.status, changeSetId: r.changeSetId, createdAt: await nextMessageTime(tx, projectId, userRow!.createdAt),
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
      return { status: "applied", changeSetId, botRowId, questions: built.questionRefs.map(keyOf), contradictions: built.contradictionRefs.map(keyOf) };
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      const label = e.index === null ? "the answer" : built.labels[e.index] ?? `change ${e.index}`;
      // A change the server made itself (an accepted question) failing is our bug, not the model's: let it be a 500.
      if (label.startsWith("server:")) throw new Error(`integrity: a server-made change was refused (${label}): ${e.message}`);
      return { status: "invalid", error: `${label}: ${e.message}` };
    }
  };

  // D-023: the bot failed, but what the user decided this turn (accept · answers · park) is still applied — one set,
  // caused by the user row, with the failure's bot row. A turn with no decisions changes nothing, as before.
  const decided = accepted.length + ownAnswers.length + parked.length > 0;
  const fail = async (status: "bot_could_not_answer" | "changes_rejected", reply: string | null, model: string, reason: string) => {
    if (!decided) return finish(status, reply, model, undefined, reason);
    const kept = await applyAnswer(NO_REPLY, model, { status, reply });
    if (kept.status !== "applied") throw new Error(`integrity: the user's decisions did not apply (${kept.status})`);
    return finish(status, reply, model, kept, reason);
  };

  // A-R3: a round that only parks has nothing to ask — it applies the server's changes with no model call.
  if (message === undefined && accept.length === 0 && answers.length === 0) {
    const parkedOnly = await applyAnswer(NO_REPLY, project.model);
    if (parkedOnly.status !== "applied") throw new Error(`integrity: a park-only round did not apply (${parkedOnly.status})`);
    return finish("applied", null, project.model, parkedOnly);
  }

  // (1) the round · (2) once more only if (1) is not our protocol · (3) one correction only if the change set is invalid.
  // A transport failure has already been retried inside the client (R8), so it ends the round.
  const first = await ask(request);
  if (!first.ok) return fail("bot_could_not_answer", null, project.model, first.reason);
  let answered = first;
  let parsed = parseReply(first.content);
  if (!parsed.ok) {
    const again = await ask(request);
    if (!again.ok) return fail("bot_could_not_answer", null, project.model, again.reason);
    answered = again;
    parsed = parseReply(again.content);
    if (!parsed.ok) return fail("bot_could_not_answer", null, modelOf(again), "protocol");
  }

  let result = await applyAnswer(parsed.reply, modelOf(answered));
  let reply = parsed.reply.reply;
  if (result.status === "invalid") {
    const correction = await ask([...request,
      { role: "assistant", content: answered.content },
      { role: "user", content: `The server refused that answer: ${result.error}. Reply again with the whole JSON, corrected. Nothing was applied.` }]);
    if (!correction.ok) return fail("changes_rejected", reply, modelOf(answered), correction.reason);
    const fixed = parseReply(correction.content);
    if (!fixed.ok) return fail("changes_rejected", reply, modelOf(correction), "protocol");
    answered = correction;
    reply = fixed.reply.reply;
    result = await applyAnswer(fixed.reply, modelOf(correction));
    if (result.status === "invalid") return fail("changes_rejected", reply, modelOf(correction), "validation");
  }
  return result.status === "applied"
    ? finish("applied", reply, modelOf(answered), result)
    : finish("no_changes", reply, modelOf(answered));
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
  }));
}
