// SPEC-A-005 § S1.1: the context of a part, read from a confirmed version's frozen snapshot only.
import { expect, test } from "bun:test";
import { projects } from "../../src/db/schema";
import { confirmVersion } from "../../src/projects/service";
import { partContext } from "../../src/seam/context";
import { NotFound } from "../../src/spec/errors";
import { applyChangeSet } from "../../src/spec/store";
import { answerQ001, meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";
import { passingQuiz } from "../helpers/quiz";

// The worked example, Q-001 answered, confirmed as v1.
async function confirmedV1() {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: [...meetingRoom, answerQ001] });
  await passingQuiz(db, p!.id);
  await confirmVersion(db, p!.id, "operator");
  return { db, pid: p!.id };
}

const caught = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e; } return null; };

test("AC-1: STEP-004 @ v1 — the labelled next from STEP-003, DEC-001, and the whole flow with `at`", async () => {
  const { db, pid } = await confirmedV1();
  const ctx = await partContext(db, pid, 1, "STEP-004");
  expect([ctx.projectId, ctx.version, ctx.part.key, ctx.part.title]).toEqual([pid, 1, "STEP-004", "ผู้ดูแลพิจารณา"]);
  expect(ctx.neighbours).toContainEqual({ direction: "in", linkKind: "next", label: "ห้องใหญ่ ต้องอนุมัติ", position: expect.any(Number),
    part: { key: "STEP-003", kind: "step", title: "ส่งคำขอจอง" } });
  expect(ctx.neighbours).toContainEqual(expect.objectContaining({ direction: "out", linkKind: "next", label: "ปฏิเสธ",
    part: { key: "STEP-006", kind: "step", title: "แจ้งว่าถูกปฏิเสธ" } }));
  expect(ctx.decisions.map((d) => d.key)).toEqual(["DEC-001"]);
  expect(ctx.flows).toHaveLength(1);
  expect(ctx.flows[0]!.work).toEqual({ key: "WRK-001", title: "จองห้องประชุม" });
  expect(ctx.flows[0]!.steps.map((s) => s.key)).toEqual(["STEP-001", "STEP-002", "STEP-003", "STEP-004", "STEP-005", "STEP-006"]);
  expect(ctx.flows[0]!.at).toEqual(["STEP-004"]);
  // A-029 step 4: every question about the part, any status, with its answer as frozen.
  expect(ctx.questions.map((q) => [q.key, q.body.status, q.body.answer])).toEqual([["Q-001", "answered", "ยกเลิกอัตโนมัติและแจ้งพนักงาน"]]);
  expect(ctx).not.toHaveProperty("openQuestions");
});

test("AC-2: a live edit after v1 does not reach the context @ v1", async () => {
  const { db, pid } = await confirmedV1();
  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [{ op: "part.update", key: "STEP-004", title: "ผู้ดูแลพิจารณาคำขอ" }] });
  expect((await partContext(db, pid, 1, "STEP-004")).part.title).toBe("ผู้ดูแลพิจารณา");
});

test("flows climb: an interaction resolves to its step", async () => {
  const { db, pid } = await confirmedV1();
  const ctx = await partContext(db, pid, 1, "INT-010"); // เปิดคำขอแล้วกดอนุมัติหรือปฏิเสธ
  expect(ctx.flows.map((f) => [f.work.key, f.at])).toEqual([["WRK-001", ["STEP-004"]]]);
});

test("flows climb: a screen resolves through the interactions that start or end at it", async () => {
  const { db, pid } = await confirmedV1();
  const ctx = await partContext(db, pid, 1, "SCR-003"); // หน้าอนุมัติคำขอ
  expect(ctx.flows.map((f) => [f.work.key, f.at])).toEqual([["WRK-001", ["STEP-004"]]]);
  // หน้ายืนยันการจอง sits in four steps; `at` follows the flow's order, not the order the climb found them in.
  const confirm = await partContext(db, pid, 1, "SCR-002");
  expect(confirm.flows.map((f) => f.at)).toEqual([["STEP-002", "STEP-003", "STEP-005", "STEP-006"]]);
});

test("flows climb: a data part resolves through carries, shows and reads/writes", async () => {
  const { db, pid } = await confirmedV1();
  // Room: carried in step 1, shown on the search screen (steps 1, 2), read by the search API (step 1).
  const ctx = await partContext(db, pid, 1, "DATA-001");
  expect(ctx.flows.map((f) => [f.work.key, f.at])).toEqual([["WRK-001", ["STEP-001", "STEP-002"]]]);
});

test("flows climb: a decision goes one hop through what it covers; a work is itself with `at` empty", async () => {
  const { db, pid } = await confirmedV1();
  expect((await partContext(db, pid, 1, "DEC-001")).flows.map((f) => f.at)).toEqual([["STEP-003", "STEP-004"]]);
  const work = await partContext(db, pid, 1, "WRK-001");
  expect(work.flows.map((f) => [f.work.key, f.steps.length, f.at])).toEqual([["WRK-001", 6, []]]);
});

test("AC-8: unknown project, version or key → NotFound", async () => {
  const { db, pid } = await confirmedV1();
  expect(await caught(partContext(db, "00000000-0000-4000-8000-000000000099", 1, "STEP-004"))).toBeInstanceOf(NotFound);
  expect(await caught(partContext(db, "not-a-uuid", 1, "STEP-004"))).toBeInstanceOf(NotFound);
  expect(await caught(partContext(db, pid, 99, "STEP-004"))).toBeInstanceOf(NotFound);
  expect(await caught(partContext(db, pid, 1, "STEP-999"))).toBeInstanceOf(NotFound);
});
