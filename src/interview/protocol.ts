// The model's reply protocol (SPEC-A-003 § Interview round). A reply that is not this shape is a protocol failure
// (the round asks once more, then `bot_could_not_answer`). Each `change` is only checked loosely here — whether it is
// a valid REQ-001 change is decided when it is applied, and a refusal there goes to the one correction call. The one
// repair made here (SPEC-105 E11): a change that carries its op under `type` is read as `op`, and the rename is reported.
import { z } from "zod";

const SaidBy = z.union([z.literal("user"), z.literal("inferred"), z.object({ source: z.string() })]);
const Asked = z.object({ text: z.string(), proposedAnswer: z.string(), cases: z.array(z.string()).default([]) });

export const ModelReply = z.object({
  reply: z.string(),
  changes: z.array(z.object({
    change: z.looseObject({ op: z.string() }),
    saidBy: SaidBy,
    // The words the change rests on — checked by the server against the user's message or the source (Provenance guard).
    quote: z.string().optional(),
    sure: z.boolean(),
    ifUnsure: Asked.optional(),
  })).default([]),
  questions: z.array(Asked.extend({ about: z.string().optional() })).default([]),
  contradictions: z.array(z.object({
    note: z.string(),
    between: z.array(z.string()),
    sourceId: z.string().optional(),
    quote: z.string().optional(),
  })).default([]),
  // Addendum A (A-R4): a proposed answer for an open question that has none. Kept by the server only for such a
  // question; everything else is dropped silently (and only the first 5 are read).
  suggestions: z.array(z.object({ key: z.string(), proposedAnswer: z.string() })).default([]),
});
export type ModelReply = z.infer<typeof ModelReply>;

// SPEC-105 E11: a change with no `op` whose `type` is one of the six op names carried the op under the wrong key — the one
// reading it can have. Nothing else is renamed (another `type` value, or a change with both keys, fails as before).
const OPS = new Set(["part.add", "part.update", "part.remove", "link.add", "link.update", "link.remove"]);
export type OpRenamed = { item: string; what: "op_renamed"; from: "type"; to: "op" };
function renameOps(json: unknown): { json: unknown; adjusted: OpRenamed[] } {
  const adjusted: OpRenamed[] = [];
  const root = json as { changes?: unknown } | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.changes)) return { json, adjusted };
  const changes = root.changes.map((it, i) => {
    const c = (it as { change?: unknown } | null)?.change as Record<string, unknown> | null | undefined;
    if (!c || typeof c !== "object" || Array.isArray(c) || "op" in c || typeof c.type !== "string" || !OPS.has(c.type)) return it;
    const { type, ...rest } = c;
    adjusted.push({ item: `changes[${i}]`, what: "op_renamed", from: "type", to: "op" });
    return { ...(it as object), change: { op: type, ...rest } };
  });
  return { json: { ...root, changes }, adjusted };
}

// Code fences around the JSON are tolerated; nothing else is. `adjusted` lists what the server renamed (E11).
export function parseReply(content: string): { ok: true; reply: ModelReply; adjusted: OpRenamed[] } | { ok: false } {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  let json: unknown;
  try { json = JSON.parse(fenced ? fenced[1]! : trimmed); } catch { return { ok: false }; }
  // Postgres cannot store a NUL character in text or jsonb: a reply carrying one is not usable.
  if (JSON.stringify(json).includes("\\u0000")) return { ok: false };
  const renamed = renameOps(json);
  const parsed = ModelReply.safeParse(renamed.json);
  return parsed.success ? { ok: true, reply: parsed.data, adjusted: renamed.adjusted } : { ok: false };
}
