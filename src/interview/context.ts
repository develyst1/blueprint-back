// What the model is sent for one round (SPEC-A-003 § Interview round, context 1–7). Pure: no I/O.
// Every block is cut to its cap, so the request stays bounded however long the chat or the spec grows (AC-11).
import type { z } from "zod";
import type { ChatMessage } from "../gateway/client";
import { LINK_KINDS, PART_KINDS, type PartKind } from "../spec/registry";
import type { Link, Part, StuckItem } from "../spec/types";

export const CAPS = { spec: 8_000, stuck: 2_000, decisions: 2_000, excerpts: 6_000, accepted: 2_000, unproposed: 2_000, answered: 4_000 } as const;
export const HISTORY = 6;
const CHUNK = 800;
const KIND_ORDER = ["work", "step", "interaction", "screen", "api", "data", "role", "system", "decision", "question", "contradiction"];

// What the model may add itself (Provenance guard rule 4): questions and contradictions have their own channels, and a
// requirement is typed in by a person (SPEC-104 D6). Here, not in round.ts, so the prompt below is built from the same list.
export const MODEL_KINDS = new Set(["work", "step", "interaction", "role", "screen", "api", "system", "data", "decision"]);

// SPEC-105 E7: a field's type as the model should write it, read from its zod schema. Objects inside a list print their field
// names only (`[{ name, label? }]`); anything the registry does not constrain prints `any`.
export const shapeOf = (schema: z.ZodType) => ((schema as unknown as { shape: Record<string, z.ZodType> }).shape);
export const optionalField = (schema: z.ZodType) => schema.safeParse(undefined).success;
function typeText(schema: z.ZodType): string {
  const def = (schema as unknown as { def: { type: string; innerType?: z.ZodType; element?: z.ZodType } }).def;
  switch (def.type) {
    case "optional": case "default": case "nullable": return typeText(def.innerType!);
    case "string": case "boolean": case "number": return def.type;
    case "enum": return (schema as unknown as { options: string[] }).options.map((o) => JSON.stringify(o)).join("|");
    case "array": {
      const element = def.element!;
      const inner = (element as unknown as { def: { type: string } }).def.type;
      return inner === "object"
        ? `[{ ${Object.entries(shapeOf(element)).map(([n, s]) => `${n}${optionalField(s) ? "?" : ""}`).join(", ")} }]`
        : `${typeText(element)}[]`;
    }
    default: return "any";
  }
}

// SPEC-105 E1: the kinds the server accepts, generated from the registry so the prompt can never drift from it. A body field
// is optional (`?`) when it accepts `undefined` (optional or defaulted); the rest are required. E7 adds each field's type.
export function kindsBlock(): string {
  const fields = (kind: PartKind) => Object.entries(shapeOf(PART_KINDS[kind].body as unknown as z.ZodType))
    .map(([name, schema]) => `${name}${optionalField(schema) ? "?" : ""}: ${typeText(schema)}`).join(", ");
  const partLines = (Object.keys(PART_KINDS) as PartKind[]).filter((k) => MODEL_KINDS.has(k)).map((k) => `- ${k} {${fields(k) ? ` ${fields(k)} ` : ""}}`);
  const side = (s: readonly string[] | "any") => (s === "any" ? "any" : s.join("|"));
  const linkLines = Object.entries(LINK_KINDS).map(([k, r]) =>
    `- ${k}: ${side(r.from)} → ${side(r.to)}${r.ordered ? " [ordered]" : ""}${r.labelled ? " [labelled]" : ""}`);
  return [
    "kind ที่ใช้ได้กับ part.add (ใน { } คือฟิลด์ของ body: ชื่อ: ชนิด, ? = ไม่บังคับ):",
    ...partLines,
    "kind ที่ใช้ได้กับ link.add (from → to):",
    ...linkLines,
    "api.path คือ path ของ API นี้ เริ่มด้วย / (เช่น /rooms) หรือ URL เต็มของบริการอื่น ขึ้นต้น http:// หรือ https:// (เช่น http://127.0.0.1:4200/health)",
    "ref คือ $ ตามด้วย a-z A-Z 0-9 _ เท่านั้น เช่น $step_view (ห้ามมี - หรือช่องว่าง)",
    "ห้ามใช้ kind อื่นนอกจากนี้ — ถ้าไม่เข้ากับ kind ไหน ให้ถามเป็น question",
  ].join("\n");
}

export const SYSTEM_PROMPT = [
  "คุณคือผู้ช่วยเก็บสเปกของ Blueprint คุยกับผู้ใช้เป็นภาษาไทย สุภาพ กระชับ",
  "ถามเฉพาะสิ่งที่สเปก การตัดสินใจ และเอกสารยังตอบไม่ได้ ไม่ถามซ้ำสิ่งที่มีอยู่แล้ว",
  "ถ้าไม่แน่ใจ ให้ถาม อย่าเดา: ใส่ sure เป็น false พร้อม ifUnsure (คำถาม + คำตอบที่เสนอ + กรณีที่ครอบคลุม)",
  "ทุกคำถามต้องมี proposedAnswer ที่ไม่ว่าง",
  "ตอบเป็น JSON ก้อนเดียวเท่านั้น ห้ามมีข้อความอื่น รูปแบบ:",
  '{ "reply": string, "changes": [ { "change": <Change ไม่มี origin>, "saidBy": "user" | "inferred" | { "source": "<source id>" }, "sure": boolean, "ifUnsure"?: { "text": string, "proposedAnswer": string, "cases": string[] } } ], "questions": [ { "text": string, "proposedAnswer": string, "cases": string[], "about"?: "<part key หรือ $ref>" } ], "contradictions": [ { "note": string, "between": ["<part key>", …], "sourceId"?: string, "quote"?: string } ] }',
  "Change คือ object ที่มีช่อง \"op\" (ห้ามใช้ชื่ออื่น เช่น type) — op คือ part.add (ref เช่น $a, kind, title, body) · part.update (key, title?, body?) · part.remove (key) · link.add (kind, from, to, position?, label?) · link.update (id, position?, label?) · link.remove (id)",
  "saidBy: user = ผู้ใช้พูดเอง · inferred = คุณอนุมานเอง · source = มาจากเอกสารนั้น",
  "ทุก work ต้องมี body.goal: ย่อหน้าเดียว (ไม่เกิน 400 ตัวอักษร) บอกว่าผู้ใช้ต้องการอะไร เขียนเป็นความเข้าใจของเรา และแก้ด้วย part.update เมื่อความเข้าใจเปลี่ยน · ทุก role ต้องมี body.duty: บทบาทนี้ทำอะไรในงานนี้ บรรทัดเดียว (ไม่เกิน 120 ตัวอักษร)",
  'คำถามที่ยังเปิดและยังไม่มีคำตอบที่เสนอ: เสนอคำตอบได้ใน "suggestions": [ { "key": "<question key>", "proposedAnswer": string } ] (ไม่เกิน 5) — ห้ามแก้คำถามผ่าน changes',
  kindsBlock(),
].join("\n");

const HEADINGS = {
  spec: "## สเปกตอนนี้\n",
  stuck: "\n\n## สิ่งที่ยังติด\n",
  decisions: "\n\n## การตัดสินใจ\n",
  excerpts: "\n\n## ข้อความจากเอกสาร\n",
  accepted: "\n\n## คำถามที่ผู้ใช้ยอมรับคำตอบแล้ว\n",
  unproposed: "\n\n## คำถามที่ยังไม่มีคำตอบที่เสนอ\n",
  answered: "\n\n## คำตอบของผู้ใช้\n",
};
// Fixed text around the capped blocks: the headings, plus nothing else (AC-11's bound).
export const HEADINGS_MAX = Object.values(HEADINGS).reduce((n, h) => n + h.length, 0);

// Lines joined while they fit `max`; the rest is counted as "… (n more)". Never longer than `max`.
export function capped(lines: string[], max: number): string {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const tail = `… (${lines.length - i} more)`;
    const add = (out.length ? 1 : 0) + lines[i]!.length;
    const roomForTail = i < lines.length - 1 ? 1 + tail.length : 0;
    if (used + add + roomForTail > max) {
      if (used + (out.length ? 1 : 0) + tail.length <= max) out.push(tail);
      return out.join("\n");
    }
    out.push(lines[i]!);
    used += add;
  }
  return out.join("\n");
}

const rank = (kind: string) => { const i = KIND_ORDER.indexOf(kind); return i < 0 ? KIND_ORDER.length : i; };

function fieldOf(p: Part): string {
  const goal = p.kind === "work" ? p.body.goal : undefined;
  const duty = p.kind === "role" ? p.body.duty : undefined;
  return typeof goal === "string" && goal !== "" ? ` goal: "${goal}"` : typeof duty === "string" && duty !== "" ? ` duty: "${duty}"` : "";
}

export function specBlock(parts: Part[], links: Link[]): string {
  const ordered = [...parts].sort((a, b) => rank(a.kind) - rank(b.kind));
  return capped([
    // a work's goal and a role's duty follow the title, so the model updates them instead of adding them again (TASK-C-044)
    ...ordered.map((p) => `${p.key} ${p.kind} "${p.title}"${fieldOf(p)}`),
    ...links.map((l) => `${l.fromKey} -${l.kind}-> ${l.toKey}${l.label ? ` [${l.label}]` : ""}`),
  ], CAPS.spec);
}

export function stuckBlock(stuck: StuckItem[]): string {
  return capped(stuck.map((s) => `${s.kind}${s.reason ? `/${s.reason}` : ""} ${s.key} "${s.title}"`
    + (s.between ? ` between ${s.between.join(", ")}` : "")), CAPS.stuck);
}

export function decisionsBlock(parts: Part[]): string {
  return capped(parts.filter((p) => p.kind === "decision").map((p) => {
    const cases = Array.isArray(p.body.cases) ? (p.body.cases as string[]).join("; ") : "";
    return `${p.key} ${String(p.body.rule ?? p.title)}${cases ? ` — ${cases}` : ""}`;
  }), CAPS.decisions);
}

const segmenter = new Intl.Segmenter("th", { granularity: "word" });
// Words of a text, Thai-aware; one-letter words dropped.
export function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const s of segmenter.segment(text.toLowerCase())) if (s.isWordLike && s.segment.length > 1) out.add(s.segment);
  return out;
}

export type SourceForContext = { id: string; name: string; status: string; reason?: string; text?: string };

// Best-matching ~800-character chunks of the read sources, best first; failed sources are named as missing (AC-2).
export function excerptsBlock(sources: SourceForContext[], query: string): string {
  const missing = sources.filter((s) => s.status === "failed").map((s) => `missing source "${s.name}" (${s.reason ?? "failed"})`);
  const q = words(query);
  const chunks: { score: number; order: number; line: string }[] = [];
  let order = 0;
  for (const s of sources) {
    if (s.status !== "read" || !s.text) continue;
    for (let at = 0; at < s.text.length; at += CHUNK) {
      const chunk = s.text.slice(at, at + CHUNK);
      const own = words(chunk);
      let score = 0;
      for (const w of q) if (own.has(w)) score++;
      if (score > 0) chunks.push({ score, order: order++, line: `[source ${s.id} "${s.name}"] ${chunk.replace(/\s+/g, " ").trim()}` });
    }
  }
  chunks.sort((a, b) => b.score - a.score || a.order - b.order);
  return capped([...missing, ...chunks.map((c) => c.line)], CAPS.excerpts);
}

export type ContextInput = {
  parts: Part[]; links: Link[]; stuck: StuckItem[]; sources: SourceForContext[];
  history: { role: "user" | "bot" | "caw"; content: string }[]; // oldest first; the last HISTORY are used
  message?: string;
  accepted: { key: string; text: string; proposedAnswer: string }[];
  answered?: { key: string; text: string }[]; // Addendum A (A-R2): the user's own answers this round
};

export function buildRequest(c: ContextInput): ChatMessage[] {
  const openQuestions = c.parts.filter((p) => p.kind === "question" && p.body.status === "open").map((p) => String(p.body.text ?? p.title));
  const query = [c.message ?? "", ...c.stuck.map((s) => s.title), ...openQuestions].join(" ");
  // Addendum A (A-R4): the open questions the model may propose an answer for.
  const unproposed = c.parts.filter((p) => p.kind === "question" && p.body.status === "open" && !String(p.body.proposedAnswer ?? "").trim());
  const context = HEADINGS.spec + specBlock(c.parts, c.links)
    + HEADINGS.stuck + stuckBlock(c.stuck)
    + HEADINGS.decisions + decisionsBlock(c.parts)
    + HEADINGS.excerpts + excerptsBlock(c.sources, query)
    + (unproposed.length ? HEADINGS.unproposed + capped(unproposed.map((p) => `${p.key} "${String(p.body.text ?? p.title)}"`), CAPS.unproposed) : "");
  const accepted = c.accepted.length
    ? HEADINGS.accepted + capped(c.accepted.map((a) => `${a.key} "${a.text}" → ${a.proposedAnswer} (the user accepts)`), CAPS.accepted)
    : "";
  const answered = c.answered?.length
    ? HEADINGS.answered + capped(c.answered.map((a) => `the user answered ${a.key}: ${a.text}`), CAPS.answered)
    : "";
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: context },
    // A `caw` amendment is a user turn; its stored content already starts with `[CAW <from>]` (SPEC-A-005 § S2.4).
    ...c.history.slice(-HISTORY).map((m): ChatMessage => ({ role: m.role === "bot" ? "assistant" : "user", content: m.content })),
    { role: "user", content: `${c.message ?? ""}${accepted}${answered}` },
  ];
}
