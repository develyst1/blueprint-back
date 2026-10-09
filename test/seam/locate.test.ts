// SPEC-A-005 § S1.2: locate a request in the latest confirmed version — a deterministic Thai word match, no model.
import { expect, test } from "bun:test";
import { projects } from "../../src/db/schema";
import { confirmVersion } from "../../src/projects/service";
import { locate, NoConfirmedVersion, scoreAll } from "../../src/seam/locate";
import { applyChangeSet } from "../../src/spec/store";
import { answerQ001, meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";
import { passingQuiz } from "../helpers/quiz";

async function project(confirm: boolean) {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: [...meetingRoom, answerQ001] });
  if (confirm) {
    await passingQuiz(db, p!.id);
    await confirmVersion(db, p!.id, "operator");
  }
  return { db, pid: p!.id };
}

test("AC-3: \"อนุมัติห้องใหญ่\" → STEP-004 among the first 3, with matched words and where", async () => {
  const { db, pid } = await project(true);
  const res = await locate(db, pid, "อนุมัติห้องใหญ่");
  console.log(`AC-3 response: ${JSON.stringify(res)}`);
  expect(res.version).toBe(1);
  expect(res.notInSpec).toBe(false);
  const i = res.candidates.findIndex((c) => c.key === "STEP-004");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(i).toBeLessThan(3);
  expect(res.candidates[i]).toMatchObject({ kind: "step", title: "ผู้ดูแลพิจารณา", score: 1, where: ["link label"] });
  expect([...res.candidates[i]!.matched].sort()).toEqual(["ห้อง", "ใหญ่", "อนุมัติ"].sort());
  expect(res.candidates.length).toBeLessThanOrEqual(10);
  for (const c of res.candidates) expect(c.score).toBeGreaterThanOrEqual(0.5);
});

test("AC-4: \"ระบบจ่ายเงินเดือน\" → notInSpec, no candidates", async () => {
  const { db, pid } = await project(true);
  const res = await locate(db, pid, "ระบบจ่ายเงินเดือน");
  const below = (await scoreAll(db, pid, "ระบบจ่ายเงินเดือน")).filter((c) => c.score > 0);
  console.log(`AC-4 response: ${JSON.stringify(res)} · sub-threshold: ${JSON.stringify(below.map((c) => [c.key, c.score, c.matched]))}`);
  expect(res).toEqual({ version: 1, notInSpec: true, candidates: [] });
  for (const c of below) expect(c.score).toBeLessThan(0.5);
});

test("ordering: score, then more matched words, then key", async () => {
  const { db, pid } = await project(true);
  const res = await locate(db, pid, "อนุมัติห้องใหญ่");
  const keys = res.candidates.map((c) => c.key);
  expect(keys.slice(0, 3)).toEqual(["DEC-001", "STEP-003", "STEP-004"]);
});

test("AC-8: locate before any confirmed version → NoConfirmedVersion", async () => {
  const { db, pid } = await project(false);
  let err: unknown;
  try { await locate(db, pid, "อนุมัติห้องใหญ่"); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(NoConfirmedVersion);
});
