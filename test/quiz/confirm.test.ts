// SPEC-A-004 rules 8–9: the confirm gate and the frozen quiz on the version.
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { projects } from "../../src/db/schema";
import { createGateway, type GatewayFetch } from "../../src/gateway/client";
import { runRound } from "../../src/interview/round";
import { confirmVersion, getVersion } from "../../src/projects/service";
import { addItem, markItem, startQuiz } from "../../src/quiz/store";
import { ConfirmBlocked, QuizMissing, QuizNot100, QuizStale } from "../../src/spec/errors";
import { applyChangeSet, loadSpec } from "../../src/spec/store";
import { computeStuck } from "../../src/spec/stuck";
import { answerQ001, meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";
import { passingQuiz } from "../helpers/quiz";

const TODAY = "2026-10-09";
async function caught(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error("expected a rejection");
}
// The worked example with Q-001 answered: nothing stuck.
async function unstuck() {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: meetingRoom });
  await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: [answerQ001] });
  return { db, pid: p!.id };
}

test("AC-6: nothing stuck + a passing quiz → confirm makes version 1", async () => {
  const { db, pid } = await unstuck();
  await passingQuiz(db, pid);
  expect(await confirmVersion(db, pid, "operator")).toEqual({ version: 1 });
});

test("AC-7: no quiz → quiz_missing; 4 right of 5 → quiz_not_100 with { right, marked }", async () => {
  const { db, pid } = await unstuck();
  expect(await caught(confirmVersion(db, pid, "operator"))).toBeInstanceOf(QuizMissing);
  const quiz = await startQuiz(db, pid);
  let wrongKey = "";
  for (const [i, mark] of (["right", "right", "right", "right", "wrong"] as const).entries()) {
    const item = await addItem(db, pid, quiz.id, { question: `ข้อ ${i}`, status: "answered", answer: "a", notInSpec: false, parts: [], model: "m" });
    const after = await markItem(db, pid, quiz.id, item.id, { mark }, { today: TODAY });
    if (after.questionKey) wrongKey = after.questionKey;
  }
  // The wrong mark made an open question; answer it so nothing is stuck (SPEC-A-004 rule 8's order note):
  // the quiz is then also stale, and quiz_not_100 must still be the one reported.
  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [
    { op: "part.update", key: wrongKey, body: { text: "ข้อ 4", status: "answered", answer: "ตอบแล้ว" } }] });
  const err = await caught(confirmVersion(db, pid, "operator"));
  expect(err).toBeInstanceOf(QuizNot100);
  expect([(err as QuizNot100).right, (err as QuizNot100).marked]).toEqual([4, 5]);
});

test("AC-8: a passing quiz followed by any change set → quiz_stale", async () => {
  const { db, pid } = await unstuck();
  await passingQuiz(db, pid);
  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [{ op: "part.update", key: "STEP-001", title: "ค้นหาห้อง" }] });
  expect(await caught(confirmVersion(db, pid, "operator"))).toBeInstanceOf(QuizStale);
});

test("AC-9: the version keeps its quiz frozen — a later quiz does not touch it; the database refuses an update", async () => {
  const { db, pid } = await unstuck();
  const quiz = await passingQuiz(db, pid);
  await confirmVersion(db, pid, "operator");
  const first = await getVersion(db, pid, 1);
  expect(first.quiz).toMatchObject({ id: quiz.id, right: 5, marked: 5, score: 100 });
  expect(first.quiz!.items).toHaveLength(5);
  const frozen = JSON.stringify(first.quiz);

  const later = await startQuiz(db, pid);
  const item = await addItem(db, pid, later.id, { question: "อีกข้อ", status: "answered", answer: "ไม่เหมือนเดิม", notInSpec: true, parts: [], model: "m" });
  await markItem(db, pid, later.id, item.id, { mark: "right" }, { today: TODAY });
  expect(JSON.stringify((await getVersion(db, pid, 1)).quiz)).toBe(frozen);

  let refused = "";
  try { await db.execute(sql`update versions set quiz = '{}'::jsonb`); } catch (e) {
    refused = (e as { cause?: { message?: string } }).cause?.message ?? String(e);
  }
  expect(refused).toMatch(/immutable/);
});

test("order: something stuck → confirm_blocked before any quiz code", async () => {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "x" }).returning();
  await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: meetingRoom }); // Q-001 still open
  expect(await caught(confirmVersion(db, p!.id, "operator"))).toBeInstanceOf(ConfirmBlocked);
});

test("AC-A5 (TASK-A-033): 1 of 5 marked ผิด → confirm refused → answer that question by id → nothing stuck → new quiz 5/5 → confirmed", async () => {
  const { db, pid } = await unstuck();
  const quiz = await startQuiz(db, pid);
  let wrongKey = "";
  for (const [i, mark] of (["right", "right", "right", "right", "wrong"] as const).entries()) {
    const item = await addItem(db, pid, quiz.id, { question: `ข้อ ${i}`, status: "answered", answer: "a", notInSpec: false, parts: [], model: "m" });
    const after = await markItem(db, pid, quiz.id, item.id, { mark }, { today: TODAY });
    if (mark === "wrong") wrongKey = after.questionKey!;
  }
  expect(await caught(confirmVersion(db, pid, "operator"))).toBeInstanceOf(ConfirmBlocked);

  // One round answering it by id (recorded reply, no change from the model).
  const fetch: GatewayFetch = async () => new Response(JSON.stringify({ success: true, data: { provider: "openai", model: "gpt-4.1-mini",
    content: JSON.stringify({ reply: "รับทราบ", changes: [], questions: [], contradictions: [] }), usage: {}, latency_ms: 5 } }));
  const round = await runRound(db, createGateway({ baseUrl: "https://gateway.example.com", fetch }), pid,
    { answers: [{ key: wrongKey, text: "คำตอบที่ถูกคือผู้ดูแลห้องเป็นคนอนุมัติ" }] }, { today: TODAY });
  expect(round.status).toBe("applied");
  expect(computeStuck(await loadSpec(db, pid))).toEqual([]);

  await passingQuiz(db, pid);
  expect(await confirmVersion(db, pid, "operator")).toEqual({ version: 1 });
});
