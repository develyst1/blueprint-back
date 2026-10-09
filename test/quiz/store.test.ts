// SPEC-A-004 rules 1–3, 5–7: the quiz store (no gateway — items are inserted as the answering step would).
import { expect, test } from "bun:test";
import type { Db } from "../../src/db/client";
import { projects } from "../../src/db/schema";
import { addItem, latestQuiz, markItem, readQuiz, startQuiz } from "../../src/quiz/store";
import { AlreadyMarked, NotMarkable, QuizClosed, QuizFull, QuizStale, ValidationError } from "../../src/spec/errors";
import { applyChangeSet, loadSpec, undoChangeSet } from "../../src/spec/store";
import { computeStuck } from "../../src/spec/stuck";
import { meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";

const TODAY = "2026-10-09";
async function caught(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error("expected a rejection");
}
async function project() {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: meetingRoom });
  return { db, pid: p!.id };
}
const answered = (question: string, parts: string[] = []) =>
  ({ question, status: "answered" as const, answer: "คำตอบ", notInSpec: false, parts, model: "openai/gpt-4.1-mini" });
const failed = (question: string) =>
  ({ question, status: "failed" as const, answer: null, notInSpec: false, parts: [], model: "tier:medium" });
async function marked(db: Db, pid: string, quizId: string, marks: ("right" | "wrong")[]) {
  for (const [i, mark] of marks.entries()) {
    const item = await addItem(db, pid, quizId, answered(`คำถามข้อ ${i + 1}`));
    await markItem(db, pid, quizId, item.id, { mark }, { today: TODAY });
  }
}

test("AC-3 / AC-4 / floor: score needs 5 marks and never rounds up", async () => {
  const { db, pid } = await project();
  const a = await startQuiz(db, pid);
  await marked(db, pid, a.id, ["right", "right", "right", "right", "wrong"]);
  expect(await readQuiz(db, pid, a.id)).toMatchObject({ right: 4, marked: 5, score: 80 });

  const { db: db2, pid: pid2 } = await project();
  const b = await startQuiz(db2, pid2);
  await marked(db2, pid2, b.id, ["right", "right", "right", "right"]);
  expect(await readQuiz(db2, pid2, b.id)).toMatchObject({ right: 4, marked: 4, score: null });

  const { db: db3, pid: pid3 } = await project();
  const c = await startQuiz(db3, pid3);
  await marked(db3, pid3, c.id, ["right", "right", "right", "right", "right", "wrong"]);
  expect((await readQuiz(db3, pid3, c.id)).score).toBe(83);
});

test("AC-5: a wrong mark becomes an open question by the operator, about the parts the answer used", async () => {
  const { db, pid } = await project();
  const quiz = await startQuiz(db, pid);
  const item = await addItem(db, pid, quiz.id, answered("ใครอนุมัติห้องใหญ่", ["STEP-004", "DEC-001"]));
  const after = await markItem(db, pid, quiz.id, item.id, { mark: "wrong", note: "ต้องเป็นผู้จัดการฝ่าย" }, { today: TODAY });
  expect(after.mark).toBe("wrong");
  const key = after.questionKey!;
  const spec = await loadSpec(db, pid);
  const q = spec.parts.find((p) => p.key === key)!;
  expect(q.body).toMatchObject({ text: "ใครอนุมัติห้องใหญ่", status: "open" });
  expect(q.origin).toEqual({ stamp: "operator", date: TODAY, note: "ต้องเป็นผู้จัดการฝ่าย" });
  expect(spec.links.filter((l) => l.kind === "about" && l.fromKey === key).map((l) => l.toKey).sort()).toEqual(["DEC-001", "STEP-004"]);
  expect(computeStuck(spec).some((i) => i.kind === "open_question" && i.key === key)).toBe(true);

  const bare = await addItem(db, pid, quiz.id, answered("ห้องมีกี่ชั้น"));
  const k2 = (await markItem(db, pid, quiz.id, bare.id, { mark: "wrong" }, { today: TODAY })).questionKey!;
  const spec2 = await loadSpec(db, pid);
  expect(spec2.parts.find((p) => p.key === k2)!.origin).toEqual({ stamp: "operator", date: TODAY });
  expect(spec2.links.filter((l) => l.fromKey === k2)).toEqual([]);
});

test("rule 3: at most 10 answered items; failed ones do not count; question text is checked", async () => {
  const { db, pid } = await project();
  const quiz = await startQuiz(db, pid);
  for (let i = 1; i <= 3; i++) await addItem(db, pid, quiz.id, failed(`ล้มเหลว ${i}`));
  for (let i = 1; i <= 10; i++) await addItem(db, pid, quiz.id, answered(`ข้อ ${i}`));
  expect(await caught(addItem(db, pid, quiz.id, answered("ข้อ 11")))).toBeInstanceOf(QuizFull);
  expect((await readQuiz(db, pid, quiz.id)).items).toHaveLength(13);
  for (const bad of ["   ", "x".repeat(1_001), "a\u0000b"]) {
    expect(await caught(addItem(db, pid, quiz.id, answered(bad)))).toBeInstanceOf(ValidationError);
  }
});

test("rule 5: a mark is final; a failed item cannot be marked · rule 1: an older quiz is closed", async () => {
  const { db, pid } = await project();
  const old = await startQuiz(db, pid);
  const item = await addItem(db, pid, old.id, answered("ข้อแรก"));
  const bad = await addItem(db, pid, old.id, failed("ข้อที่ล้ม"));
  await markItem(db, pid, old.id, item.id, { mark: "right" }, { today: TODAY });
  expect(await caught(markItem(db, pid, old.id, item.id, { mark: "wrong" }, { today: TODAY }))).toBeInstanceOf(AlreadyMarked);
  expect(await caught(markItem(db, pid, old.id, bad.id, { mark: "right" }, { today: TODAY }))).toBeInstanceOf(NotMarkable);

  const unmarked = await addItem(db, pid, old.id, answered("ข้อสอง"));
  const fresh = await startQuiz(db, pid);
  expect((await latestQuiz(db, pid)).id).toBe(fresh.id);
  expect(await caught(addItem(db, pid, old.id, answered("ข้อสาม")))).toBeInstanceOf(QuizClosed);
  expect(await caught(markItem(db, pid, old.id, unmarked.id, { mark: "right" }, { today: TODAY }))).toBeInstanceOf(QuizClosed);
});

test("rule 2: stale after any other change set (an undo too), but not after this quiz's own wrong marks", async () => {
  const { db, pid } = await project();
  const quiz = await startQuiz(db, pid);
  const item = await addItem(db, pid, quiz.id, answered("ข้อแรก", ["STEP-001"]));
  await markItem(db, pid, quiz.id, item.id, { mark: "wrong" }, { today: TODAY });
  expect((await readQuiz(db, pid, quiz.id)).stale).toBe(false);

  const cs = await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [{ op: "part.update", key: "STEP-001", title: "ค้นหา" }] });
  expect((await readQuiz(db, pid, quiz.id)).stale).toBe(true);
  expect(await caught(addItem(db, pid, quiz.id, answered("ข้อสอง")))).toBeInstanceOf(QuizStale);

  const q2 = await startQuiz(db, pid);
  expect((await readQuiz(db, pid, q2.id)).stale).toBe(false);
  await undoChangeSet(db, pid, cs.changeSetId);
  expect((await readQuiz(db, pid, q2.id)).stale).toBe(true);
});
