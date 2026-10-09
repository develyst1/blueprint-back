// SPEC-A-004 rule 4: answer one quiz question from the spec only — no sources, no chat messages, no stuck list.
// That is the point of the quiz: it tests what the spec says, not what the documents say.
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { projects } from "../db/schema";
import type { ChatMessage, Gateway } from "../gateway/client";
import { capped } from "../interview/context";
import { NotFound } from "../spec/errors";
import { loadSpec } from "../spec/store";
import type { Link, Part } from "../spec/types";

export const QUIZ_CONTEXT_CAP = 24_000;

export const QUIZ_PROMPT = [
  "คุณคือผู้ช่วยตอบคำถามเกี่ยวกับสเปกของ Blueprint ตอบเป็นภาษาไทย สั้นและตรง",
  "ตอบจากสเปกด้านล่างเท่านั้น ห้ามเดา ห้ามใช้ความรู้นอกสเปก ถ้าสเปกไม่ได้บอก ให้บอกว่าไม่มีในสเปก",
  "ระบุ key ของ part ที่คุณใช้ตอบ",
  'ตอบเป็น JSON ก้อนเดียวเท่านั้น: { "answer": string, "parts": ["<part key>", …], "notInSpec": boolean }',
].join("\n");

// Every live part with its body, then every link — cut to the cap with "… (n more)".
export function specBlock(parts: Part[], links: Link[], cap: number = QUIZ_CONTEXT_CAP): string {
  return capped([
    ...parts.map((p) => `${p.key} ${p.kind} "${p.title}" ${JSON.stringify(p.body)}`),
    ...links.map((l) => `${l.fromKey} -${l.kind}-> ${l.toKey}${l.label ? ` [${l.label}]` : ""}`),
  ], cap);
}

const Reply = z.object({ answer: z.string().trim().min(1), parts: z.array(z.string()), notInSpec: z.boolean() });

function parse(content: string): z.infer<typeof Reply> | null {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  let json: unknown;
  try { json = JSON.parse(fenced ? fenced[1]! : trimmed); } catch { return null; }
  if (JSON.stringify(json).includes("\\u0000")) return null; // Postgres cannot store a NUL
  const r = Reply.safeParse(json);
  return r.success ? r.data : null;
}

export type Answered = { status: "answered" | "failed"; answer: string | null; notInSpec: boolean; parts: string[]; model: string };

export async function answerQuestion(db: Db, gateway: Gateway, projectId: string, question: string): Promise<Answered> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new NotFound("project");
  const spec = await loadSpec(db, projectId);
  const request: ChatMessage[] = [
    { role: "system", content: QUIZ_PROMPT },
    { role: "system", content: `## สเปก\n${specBlock(spec.parts, spec.links)}` },
    { role: "user", content: question },
  ];
  const failed = (reason: string): Answered => {
    console.error(`[quiz] failed reason=${reason}`); // codes only — never the question, the spec or a reply
    return { status: "failed", answer: null, notInSpec: false, parts: [], model: project.model };
  };
  const ask = () => gateway.chat({ model: project.model, creativity: project.creativity, messages: request });

  // Transport failures were already retried inside the client (R8); a reply that is not our JSON gets one more call.
  let got = await ask();
  if (!got.ok) return failed(got.reason);
  let reply = parse(got.content);
  if (!reply) {
    got = await ask();
    if (!got.ok) return failed(got.reason);
    reply = parse(got.content);
    if (!reply) return failed("protocol");
  }
  const live = new Set(spec.parts.map((p) => p.key));
  return {
    status: "answered", answer: reply.answer, notInSpec: reply.notInSpec,
    parts: reply.notInSpec ? [] : [...new Set(reply.parts.filter((k) => live.has(k)))], // unknown keys dropped
    model: `${got.provider}/${got.model}`,
  };
}
