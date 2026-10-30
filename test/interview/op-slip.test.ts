// REQ-110 round 4 / SPEC-105 E11, E11b, E12 (TASK-130): a change that carries its op under `type` is read as `op` (and the rename is
// recorded), the prompt names the field, and the round's first answer may take longer than the later calls.
// Replays the live accept round of TEST-107 round 3 (every change used `type`) on a stub — no live call.
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/db/client";
import { messages, projects } from "../../src/db/schema";
import { createGateway } from "../../src/gateway/client";
import { SYSTEM_PROMPT } from "../../src/interview/context";
import { parseReply } from "../../src/interview/protocol";
import { runRound } from "../../src/interview/round";
import { applyChangeSet, loadSpec } from "../../src/spec/store";
import type { Change } from "../../src/spec/types";
import { testDb } from "../helpers/db";

const TODAY = "2026-10-29";
const MESSAGE = "ตามนั้น";
// test/fixtures/op-slip-accept-reply.json = the recorded `roundRaw` of TEST-107 r3 (cut at 4000 chars), closed with `": [] }`.
const REPLAY = await Bun.file(new URL("../fixtures/op-slip-accept-reply.json", import.meta.url)).text();

function stub(contents: string[]) {
  const calls = { n: 0 };
  const gateway = createGateway({
    baseUrl: "https://gateway.example.com",
    fetch: async () => {
      const next = contents[Math.min(calls.n++, contents.length - 1)]!;
      return new Response(JSON.stringify({ success: true, data: { provider: "openai", model: "stub", content: next, usage: {}, latency_ms: 1 } }));
    },
  });
  return { gateway, calls };
}
// What the live project held before its accept round: parts the AI itself proposed (stamp `team-proposed`, so an update by the
// AI needs no user quote) — WRK-001, STEP-001, SCR-001 and the open question Q-001 that the replay's changes name.
const origin = { stamp: "team-proposed", date: TODAY } as const;
const seed: Change[] = [
  { op: "part.add", ref: "$w", kind: "work", title: "Health Board", body: { goal: "หน้าเว็บแสดงสถานะบริการ" }, origin },
  { op: "part.add", ref: "$s", kind: "step", title: "ดูสถานะ", body: { ends: true }, origin },
  { op: "part.add", ref: "$c", kind: "screen", title: "หน้า Health Board", body: {}, origin },
  { op: "part.add", ref: "$q", kind: "question", title: "เกณฑ์ว่าทำงาน", body: { text: "URL ที่ไม่มี /health ถือว่าทำงานเมื่อไร?", cases: [], status: "open", proposedAnswer: "HTTP 2xx/3xx ภายใน 3 วินาที" }, origin },
];
async function project(): Promise<{ db: Db; pid: string }> {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "Health Board" }).returning();
  await applyChangeSet(db, p!.id, { cause: { kind: "operator" }, changes: seed });
  return { db, pid: p!.id };
}
const rowOf = async (db: Db, id: string) => (await db.select().from(messages).where(eq(messages.id, id)))[0]!;
const reply = (change: Record<string, unknown>) =>
  JSON.stringify({ reply: "ok", changes: [{ change, saidBy: "inferred", sure: true }], questions: [], contradictions: [] });

// --- E11: parseReply ---------------------------------------------------------------------------------------------

test("E11: `type` with an op name and no `op` → renamed, reported; `op` first in the change, the rest kept", () => {
  const p = parseReply(reply({ type: "part.update", key: "SCR-001", title: "x" }));
  expect(p.ok).toBe(true);
  if (!p.ok) return;
  expect(p.reply.changes[0]!.change).toEqual({ op: "part.update", key: "SCR-001", title: "x" });
  expect(p.adjusted).toEqual([{ item: "changes[0]", what: "op_renamed", from: "type", to: "op" }]);
});

test("E11: every one of the six op names is read from `type`", () => {
  for (const op of ["part.add", "part.update", "part.remove", "link.add", "link.update", "link.remove"]) {
    const p = parseReply(reply({ type: op }));
    expect(p.ok && p.reply.changes[0]!.change.op).toBe(op);
  }
});

test("E11: `type: \"kind\"` (or any non-op value) stays unreadable; a change with both `op` and `type` keeps `op` and renames nothing", () => {
  expect(parseReply(reply({ type: "kind", key: "SCR-001" })).ok).toBe(false);
  expect(parseReply(reply({ type: "part.add", kind: "role" })).ok).toBe(true); // control: the op name is what makes it readable
  expect(parseReply(reply({ type: 5 })).ok).toBe(false);
  const both = parseReply(reply({ op: "part.remove", type: "part.add", key: "SCR-001" }));
  expect(both.ok).toBe(true);
  if (!both.ok) return;
  expect(both.reply.changes[0]!.change).toMatchObject({ op: "part.remove", type: "part.add" });
  expect(both.adjusted).toEqual([]);
  expect(parseReply(reply({ key: "SCR-001" })).ok).toBe(false); // neither key
});

test("E11: a part body's own `type` is not a change's `type` and is left alone", () => {
  const p = parseReply(reply({ op: "part.update", key: "SCR-001", body: { type: "part.add" } }));
  expect(p.ok && p.adjusted).toEqual([]);
});

// --- AC-8: the live replay ---------------------------------------------------------------------------------------

test("AC-8 replay (TEST-107 r3): 9 changes that all say `type` → applied, all 9 stored, 9 op_renamed, 1 call", async () => {
  const { db, pid } = await project();
  const before = await loadSpec(db, pid);
  expect(before.parts.some((p) => p.key === "SCR-001" && p.kind === "screen")).toBe(true);
  const g = stub([REPLAY]);
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, g.calls.n]).toEqual(["applied", 1]);
  expect(round.refused).toBeNull();
  const spec = await loadSpec(db, pid);
  expect(spec.parts.length).toBe(before.parts.length + 6); // data + 3 decisions (the 4 part.add) + the reply's 2 questions (Q-002, Q-003)
  const data = spec.parts.find((p) => p.kind === "data" && p.title === "ผลการตรวจบริการ")!;
  const urls = JSON.stringify(data.body).match(/http:\/\/127\.0\.0\.1:\d+/g) ?? [];
  expect(urls.length).toBeGreaterThanOrEqual(4); // the data part's body holds the 4 service URLs
  expect(spec.links.length).toBe(before.links.length + 4);
  expect(spec.parts.filter((p) => p.kind === "decision" && /^(เกณฑ์ตัดสินว่า|เวลาหมดอายุ|ขอบเขตที่ไม่ทำ)/.test(p.title))).toHaveLength(3);
  expect(round.adjusted).toHaveLength(9);
  expect(round.adjusted!.every((a) => (a as { what?: string }).what === "op_renamed")).toBe(true);
  expect(round.adjusted![0]).toMatchObject({ item: "changes[0]", what: "op_renamed", from: "type", to: "op", key: "SCR-001" });
  expect(round.adjusted![1]).toMatchObject({ item: "changes[1]", ref: "$data_check", title: "ผลการตรวจบริการ" });
  expect((await rowOf(db, round.messageIds[1]!)).roundAdjusted).toEqual(round.adjusted);
});

// --- E11b: the prompt --------------------------------------------------------------------------------------------

test("E11b: the prompt names the field that carries the op, and says not to use another name such as type", () => {
  const line = SYSTEM_PROMPT.split("\n").find((l) => l.startsWith("Change คือ"))!;
  expect(line).toContain('"op"');
  expect(line).toContain("type");
  expect(line).toContain("part.add");
});

// --- E12: the first answer may take longer -----------------------------------------------------------------------

const slowGateway = (answerAfterMs: number | null, content: string) => {
  const calls = { n: 0 };
  const gateway = createGateway({
    baseUrl: "https://gateway.example.com", timeoutMs: 40, firstAnswerTimeoutMs: 200,
    fetch: (_url, init) => {
      calls.n++;
      if (answerAfterMs === null) return new Promise<Response>(() => {});
      return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({ success: true, data: { provider: "openai", model: "stub", content, usage: {}, latency_ms: 1 } }))), answerAfterMs));
    },
  });
  return { gateway, calls };
};

test("E12: an answer after 120 ms (timeoutMs 40, firstAnswerTimeoutMs 200) is stored — 1 call", async () => {
  const { db, pid } = await project();
  const g = slowGateway(120, JSON.stringify({ reply: "ok", changes: [], questions: [], contradictions: [] }));
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, g.calls.n]).toEqual(["no_changes", 1]);
});

test("E12: a gateway that never answers → bot_could_not_answer / timeout at about the first-answer limit, 1 call, no retry", async () => {
  const { db, pid } = await project();
  const g = slowGateway(null, "");
  const t0 = Date.now();
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  const took = Date.now() - t0;
  expect([round.status, round.reason, g.calls.n]).toEqual(["bot_could_not_answer", "timeout", 1]);
  expect(took).toBeGreaterThanOrEqual(190);
  expect(took).toBeLessThan(1_000);
});

test("E12: the limit applies to `firstAnswer: true` only — a plain chat call keeps timeoutMs", async () => {
  const g = slowGateway(120, "x");
  const req = { model: "tier:small", creativity: 0.5, messages: [{ role: "user" as const, content: "hi" }] };
  expect(await g.gateway.chat(req)).toEqual({ ok: false, reason: "timeout" }); // 40 ms limit, answer at 120
  expect((await g.gateway.chat(req, { firstAnswer: true })).ok).toBe(true); // 200 ms limit
});
