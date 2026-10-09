// TASK-A-037 (D-023): a bot failure never eats the user's own decisions, and { retry: true } asks the bot again for
// the same turn — recorded gateway answers only, no live call (DECISIONS 2026-10-09 l.79).
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../src/db/client";
import { changeSets, messages, projects } from "../../src/db/schema";
import { createGateway, type GatewayFetch } from "../../src/gateway/client";
import { NothingToRetry, runRound } from "../../src/interview/round";
import { ValidationError } from "../../src/spec/errors";
import { applyChangeSet, loadSpec } from "../../src/spec/store";
import { meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";

const BASE = "https://gateway.example.com";
const TODAY = "2026-10-09";
const empty = { reply: "รับทราบ", changes: [], questions: [], contradictions: [] };
let spy: ReturnType<typeof spyOn>;
beforeEach(() => { spy = spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => spy.mockRestore());

type Answer = unknown | (() => Response);
// A gateway answer: a protocol object / raw text as content, or a function that throws / returns a raw Response.
function fakeGateway(answers: Answer[]) {
  let calls = 0;
  const fetch: GatewayFetch = async () => {
    calls++;
    if (answers.length === 0) throw new Error("no more recorded answers");
    const a = answers.shift();
    if (typeof a === "function") return (a as () => Response)();
    return new Response(JSON.stringify({ success: true, data: { provider: "openai", model: "gpt-4.1-mini",
      content: typeof a === "string" ? a : JSON.stringify(a), usage: {}, latency_ms: 5 } }));
  };
  return { gateway: createGateway({ baseUrl: BASE, fetch }), calls: () => calls };
}
const down = () => { throw new Error("down"); };
const http500 = () => new Response(JSON.stringify({ success: false, error: "boom" }), { status: 500 });
const notOurs = "ผู้ดูแลอนุมัติครับ"; // plain text, not the protocol

// The worked example plus three open questions: Q-002 (no proposed answer), Q-003 (has one), Q-004 (no proposed answer).
async function project() {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  const q = (ref: string, text: string, extra: Record<string, unknown> = {}) => ({ op: "part.add" as const, ref, kind: "question" as const,
    title: text, body: { text, status: "open", ...extra }, origin: { stamp: "operator" as const, date: TODAY } });
  await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: [
    ...meetingRoom, q("$a", "ห้องใหญ่ต้องให้ใครอนุมัติ"), q("$b", "ห้องเล็กต้องอนุมัติไหม", { proposedAnswer: "ไม่ต้อง" }), q("$c", "ต้องแจ้งใครเมื่อยกเลิก"),
  ] });
  return { db, pid: p!.id };
}
const part = async (db: Db, pid: string, key: string) => (await loadSpec(db, pid)).parts.find((p) => p.key === key)!;
const row = async (db: Db, id: string) => (await db.select().from(messages).where(eq(messages.id, id)))[0]!;
const userRows = async (db: Db, pid: string) => db.select().from(messages).where(and(eq(messages.projectId, pid), eq(messages.role, "user")));
const caught = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e; } return null; };

test("D-023: answers-only, gateway down → the answer is kept (operator); the bot row is bot_could_not_answer with that set's id", async () => {
  const { db, pid } = await project();
  const r = await runRound(db, fakeGateway([down, down]).gateway, pid, { answers: [{ key: "Q-002", text: "ผู้ดูแลห้องเป็นคนอนุมัติ" }] }, { today: TODAY });
  expect([r.status, r.reply, typeof r.changeSetId]).toEqual(["bot_could_not_answer", null, "string"]);
  const q = await part(db, pid, "Q-002");
  expect([q.body.status, q.body.answer, q.origin.stamp]).toEqual(["answered", "ผู้ดูแลห้องเป็นคนอนุมัติ", "operator"]);
  const bot = await row(db, r.messageIds[1]!);
  expect([bot.roundStatus, bot.content, bot.changeSetId]).toEqual(["bot_could_not_answer", "", r.changeSetId]);
  const [cs] = await db.select().from(changeSets).where(eq(changeSets.id, r.changeSetId!));
  expect([cs!.causeKind, cs!.causeRef]).toEqual(["message", r.messageIds[0]]);
});

test("D-023: accept + gateway 500 → accepted", async () => {
  const { db, pid } = await project();
  const r = await runRound(db, fakeGateway([http500, http500]).gateway, pid, { accept: ["Q-003"] }, { today: TODAY });
  expect(r.status).toBe("bot_could_not_answer");
  expect((await part(db, pid, "Q-003")).body).toMatchObject({ status: "answered", answer: "ไม่ต้อง" });
});

test("D-023: park + message, the model not our protocol twice → parked", async () => {
  const { db, pid } = await project();
  const r = await runRound(db, fakeGateway([notOurs, notOurs]).gateway, pid, { message: "ข้อนี้ยังไม่ต้อง", park: [{ key: "Q-004", reason: "ทีหลัง" }] }, { today: TODAY });
  expect(r.status).toBe("bot_could_not_answer");
  expect((await part(db, pid, "Q-004")).body).toMatchObject({ status: "parked", parkedReason: "ทีหลัง" });
});

test("D-023: a message-only failure still changes nothing", async () => {
  const { db, pid } = await project();
  const before = await loadSpec(db, pid);
  const r = await runRound(db, fakeGateway([down, down]).gateway, pid, { message: "ช่วยเพิ่มขั้นตอนแจ้งเตือน" }, { today: TODAY });
  expect([r.status, r.changeSetId]).toEqual(["bot_could_not_answer", null]);
  expect(await loadSpec(db, pid)).toEqual(before);
  expect((await row(db, r.messageIds[1]!)).changeSetId).toBeNull();
});

test("D-023: changes_rejected with an answer in the same turn → the answer applied, the model's changes not", async () => {
  const { db, pid } = await project();
  const refused = { reply: "เพิ่มให้แล้ว", changes: [{ change: { op: "part.add", ref: "$x", kind: "question", title: "คำถามใหม่", body: { text: "คำถามใหม่" } },
    saidBy: "inferred", sure: true }], questions: [], contradictions: [] };
  const r = await runRound(db, fakeGateway([refused, refused]).gateway, pid, { message: "ต่อเลย", answers: [{ key: "Q-002", text: "ผู้ดูแลห้อง" }] }, { today: TODAY });
  expect([r.status, r.reply, typeof r.changeSetId]).toEqual(["changes_rejected", "เพิ่มให้แล้ว", "string"]);
  const spec = await loadSpec(db, pid);
  expect(spec.parts.find((p) => p.key === "Q-002")!.body).toMatchObject({ status: "answered", answer: "ผู้ดูแลห้อง" });
  expect(spec.parts.some((p) => p.title === "คำถามใหม่")).toBe(false);
  expect((await row(db, r.messageIds[1]!))).toMatchObject({ roundStatus: "changes_rejected", content: "เพิ่มให้แล้ว", changeSetId: r.changeSetId });
});

test("retry: after a failed turn → one more gateway call, no new user row, a new bot row caused by the same user row", async () => {
  const { db, pid } = await project();
  const failed = await runRound(db, fakeGateway([down, down]).gateway, pid,
    { message: "ผู้ดูแลต้องตอบภายในหนึ่งวัน", answers: [{ key: "Q-002", text: "ผู้ดูแลห้องเป็นคนอนุมัติ" }] }, { today: TODAY });
  expect(failed.status).toBe("bot_could_not_answer");
  const usersBefore = (await userRows(db, pid)).length;
  // The model now answers: a change resting on the user's words from that turn (its user row holds message + answers).
  const f = fakeGateway([{ reply: "ปรับขั้นตอนแล้ว", changes: [{ change: { op: "part.update", key: "STEP-004", title: "ผู้ดูแลพิจารณาภายในหนึ่งวัน" },
    saidBy: "user", quote: "ต้องตอบภายในหนึ่งวัน", sure: true }], questions: [], contradictions: [] }]);
  const again = await runRound(db, f.gateway, pid, { retry: true }, { today: TODAY });
  expect([again.status, f.calls(), (await userRows(db, pid)).length]).toEqual(["applied", 1, usersBefore]);
  expect(again.messageIds[0]).toBe(failed.messageIds[0]);
  const [cs] = await db.select().from(changeSets).where(eq(changeSets.id, again.changeSetId!));
  expect(cs!.causeRef).toBe(failed.messageIds[0]);
  expect((await part(db, pid, "STEP-004"))).toMatchObject({ title: "ผู้ดูแลพิจารณาภายในหนึ่งวัน", origin: { stamp: "operator" } });
  expect((await row(db, again.messageIds[1]!)).roundStatus).toBe("applied");
  // decisions are not re-applied: Q-002 was answered once, by the failed turn's set
  expect((await part(db, pid, "Q-002")).body.status).toBe("answered");

  // a retry that fails again can be retried again; one that answered cannot
  expect(await caught(runRound(db, fakeGateway([empty]).gateway, pid, { retry: true }, { today: TODAY }))).toBeInstanceOf(NothingToRetry);
});

test("retry: nothing failed → NothingToRetry (no call); retry with any other field → ValidationError", async () => {
  const { db, pid } = await project();
  const none = fakeGateway([empty]);
  expect(await caught(runRound(db, none.gateway, pid, { retry: true }, { today: TODAY }))).toBeInstanceOf(NothingToRetry); // no turn at all
  await runRound(db, fakeGateway([empty]).gateway, pid, { message: "สวัสดี" }, { today: TODAY });
  expect(await caught(runRound(db, none.gateway, pid, { retry: true }, { today: TODAY }))).toBeInstanceOf(NothingToRetry);
  expect(none.calls()).toBe(0);
  for (const extra of [{ message: "x" }, { accept: [] }, { answers: [{ key: "Q-002", text: "x" }] }, { park: [{ key: "Q-002" }] }]) {
    expect(await caught(runRound(db, none.gateway, pid, { retry: true, ...extra }, { today: TODAY }))).toBeInstanceOf(ValidationError);
  }
  expect(none.calls()).toBe(0);
});
