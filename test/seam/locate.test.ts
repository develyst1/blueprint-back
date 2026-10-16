// SPEC-A-005 § S1.2: locate a request in the latest confirmed version — a deterministic Thai word match, no model.
import { expect, test } from "bun:test";
import { projects } from "../../src/db/schema";
import { confirmVersion } from "../../src/projects/service";
import { locate, NoConfirmedVersion, scoreAll, words } from "../../src/seam/locate";
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

// ---- § S1.2b (D-076): the score also counts the part's own title ----
const FILLER = "ค้นหาแมวส้มน้อยบนดาดฟ้าตึกสูงตอนกลางคืนเงียบสงบมาก"; // words that are in no part of the fixture, bar ค้นหา — they only dilute the request share
const requestShare = (matched: string[], request: string) => Math.round((matched.length / new Set(words(request)).size) * 100) / 100;

test("S1.2b: the QA sentence — a long natural sentence containing INT-010's title word for word — finds INT-010 with score 1 (it was notInSpec at 0.35)", async () => {
  const { db, pid } = await project(true);
  const sentence = "ทำหน้าอนุมัติคำขอจองให้ผู้ดูแล: เปิดคำขอแล้วกดอนุมัติหรือปฏิเสธ แล้วแจ้งผลให้ผู้จองเห็น — เสนอการ์ดได้เลย";
  const res = await locate(db, pid, sentence);
  console.log(`S1.2b QA sentence: ${JSON.stringify(res.candidates.slice(0, 5).map((c) => [c.key, c.score]))}`);
  expect(res.notInSpec).toBe(false);
  expect(res.candidates[0]).toMatchObject({ key: "INT-010", kind: "interaction", score: 1 });
  expect(res.candidates.map((c) => [c.key, c.score]).slice(0, 4)).toEqual([["INT-010", 1], ["SCR-003", 1], ["STEP-004", 0.67], ["STEP-003", 0.67]]); // the SPEC's table
  expect(res.candidates.length).toBeLessThanOrEqual(10);
  for (const c of res.candidates) expect(c.score).toBeGreaterThanOrEqual(0.5);
});

test("S1.2b: truly missing stays missing (REQ-013 R2) — \"ขอเพิ่มหน้าสรุปรายงานรายวันด้วย\" → notInSpec, no candidates, every part under 0.5", async () => {
  const { db, pid } = await project(true);
  const request = "ขอเพิ่มหน้าสรุปรายงานรายวันด้วย";
  expect(await locate(db, pid, request)).toEqual({ version: 1, notInSpec: true, candidates: [] });
  for (const c of await scoreAll(db, pid, request)) expect([c.key, c.score < 0.5]).toEqual([c.key, true]);
});

test("S1.2b limit: a 2-word title never gets a title share — SYS-001 \"ระบบปฏิทิน\" with BOTH words in a long request stays at its request share (AC-4's part, by key)", async () => {
  const { db, pid } = await project(true);
  for (const request of ["ระบบจ่ายเงินเดือน", "ระบบ ปฏิทิน สำหรับ" + FILLER]) {
    const sys = (await scoreAll(db, pid, request)).find((c) => c.key === "SYS-001")!;
    expect([request, sys.score]).toEqual([request, requestShare(sys.matched, request)]);
    expect((await locate(db, pid, request)).candidates.map((c) => c.key)).not.toContain("SYS-001");
  }
  expect((await locate(db, pid, "ระบบจ่ายเงินเดือน")).notInSpec).toBe(true);
});

test("S1.2b limit: 1 of 3 title words matched does not get a title share — API-001 \"ค้นหาห้องว่าง\" with only ค้นหา in a long request stays at its request share", async () => {
  const { db, pid } = await project(true);
  const api = (await scoreAll(db, pid, FILLER)).find((c) => c.key === "API-001")!;
  expect(api.matched).toEqual(["ค้นหา"]);
  expect(api.score).toBe(requestShare(api.matched, FILLER)); // 1/14, not 1/3
  expect(api.score).toBeLessThan(0.1);
  expect((await locate(db, pid, FILLER)).notInSpec).toBe(true);
});

test("S1.2b limit: the title share must reach 0.6 — INT-005 (7 title words): 4 of 7 (0.57) is not counted, 5 of 7 (0.71) is, and becomes a candidate", async () => {
  const { db, pid } = await project(true);
  const four = "เปิด หน้า ยืนยัน พร้อม " + FILLER;
  const five = "เปิด หน้า ยืนยัน พร้อม ห้อง " + FILLER;
  const int5 = async (request: string) => (await scoreAll(db, pid, request)).find((c) => c.key === "INT-005")!;
  expect((await int5(four)).score).toBe(requestShare((await int5(four)).matched, four)); // request share only
  expect((await locate(db, pid, four)).candidates.map((c) => c.key)).not.toContain("INT-005");
  const got = (await locate(db, pid, five)).candidates.find((c) => c.key === "INT-005");
  expect(got).toMatchObject({ key: "INT-005", score: 0.71 }); // 5/7, rounded to 2 decimals
  expect((await locate(db, pid, five)).notInSpec).toBe(false);
});

test("S1.2b: nothing else moves — threshold 0.5, at most 10 candidates, the response shape, matched / where as before", async () => {
  const { db, pid } = await project(true);
  const res = await locate(db, pid, "ทำหน้าอนุมัติคำขอจองให้ผู้ดูแล: เปิดคำขอแล้วกดอนุมัติหรือปฏิเสธ แล้วแจ้งผลให้ผู้จองเห็น — เสนอการ์ดได้เลย");
  expect(Object.keys(res).sort()).toEqual(["candidates", "notInSpec", "version"]);
  for (const c of res.candidates) expect(Object.keys(c).sort()).toEqual(["key", "kind", "matched", "score", "title", "where"]);
  expect(res.candidates[0]!.where).toEqual(["title", "body"]); // INT-010's body repeats its title text: where keeps its meaning (every field the words are in)
  expect([...res.candidates[0]!.matched].sort()).toEqual(["กด", "คำขอ", "ปฏิเสธ", "หรือ", "อนุมัติ", "เปิด", "แล้ว"].sort());
});

test("AC-8: locate before any confirmed version → NoConfirmedVersion", async () => {
  const { db, pid } = await project(false);
  let err: unknown;
  try { await locate(db, pid, "อนุมัติห้องใหญ่"); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(NoConfirmedVersion);
});
