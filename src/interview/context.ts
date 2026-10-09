// What the model is sent for one round (SPEC-A-003 § Interview round, context 1–7). Pure: no I/O.
// Every block is cut to its cap, so the request stays bounded however long the chat or the spec grows (AC-11).
import type { ChatMessage } from "../gateway/client";
import type { Link, Part, StuckItem } from "../spec/types";

export const CAPS = { spec: 8_000, stuck: 2_000, decisions: 2_000, excerpts: 6_000, accepted: 2_000, unproposed: 2_000, answered: 4_000 } as const;
export const HISTORY = 6;
const CHUNK = 800;
const KIND_ORDER = ["work", "step", "interaction", "screen", "api", "data", "role", "system", "decision", "question", "contradiction"];

export const SYSTEM_PROMPT = [
  "คุณคือผู้ช่วยเก็บสเปกของ Blueprint คุยกับผู้ใช้เป็นภาษาไทย สุภาพ กระชับ",
  "ถามเฉพาะสิ่งที่สเปก การตัดสินใจ และเอกสารยังตอบไม่ได้ ไม่ถามซ้ำสิ่งที่มีอยู่แล้ว",
  "ถ้าไม่แน่ใจ ให้ถาม อย่าเดา: ใส่ sure เป็น false พร้อม ifUnsure (คำถาม + คำตอบที่เสนอ + กรณีที่ครอบคลุม)",
  "ทุกคำถามต้องมี proposedAnswer ที่ไม่ว่าง",
  "ตอบเป็น JSON ก้อนเดียวเท่านั้น ห้ามมีข้อความอื่น รูปแบบ:",
  '{ "reply": string, "changes": [ { "change": <Change ไม่มี origin>, "saidBy": "user" | "inferred" | { "source": "<source id>" }, "sure": boolean, "ifUnsure"?: { "text": string, "proposedAnswer": string, "cases": string[] } } ], "questions": [ { "text": string, "proposedAnswer": string, "cases": string[], "about"?: "<part key หรือ $ref>" } ], "contradictions": [ { "note": string, "between": ["<part key>", …], "sourceId"?: string, "quote"?: string } ] }',
  "Change คือ part.add (ref เช่น $a, kind, title, body) · part.update (key, title?, body?) · part.remove (key) · link.add (kind, from, to, position?, label?) · link.update (id, position?, label?) · link.remove (id)",
  "saidBy: user = ผู้ใช้พูดเอง · inferred = คุณอนุมานเอง · source = มาจากเอกสารนั้น",
  'คำถามที่ยังเปิดและยังไม่มีคำตอบที่เสนอ: เสนอคำตอบได้ใน "suggestions": [ { "key": "<question key>", "proposedAnswer": string } ] (ไม่เกิน 5) — ห้ามแก้คำถามผ่าน changes',
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

export function specBlock(parts: Part[], links: Link[]): string {
  const ordered = [...parts].sort((a, b) => rank(a.kind) - rank(b.kind));
  return capped([
    ...ordered.map((p) => `${p.key} ${p.kind} "${p.title}"`),
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
