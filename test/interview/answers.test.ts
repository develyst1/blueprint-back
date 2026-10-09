// SPEC-A-003 § Addendum A (TASK-A-033): answer a question by id in your own words, park it, and model suggestions —
// on recorded gateway answers only, no live call (DECISIONS 2026-10-09 l.79).
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import type { Db } from "../../src/db/client";
import { changeSets, messages, projects } from "../../src/db/schema";
import { createGateway, type GatewayFetch } from "../../src/gateway/client";
import { runRound } from "../../src/interview/round";
import { addItem, markItem, startQuiz } from "../../src/quiz/store";
import { ValidationError } from "../../src/spec/errors";
import { applyChangeSet, loadSpec, partHistory } from "../../src/spec/store";
import { computeStuck } from "../../src/spec/stuck";
import { answerQ001, meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";

const GW = new URL("../fixtures/gateway/", import.meta.url).pathname;
const BASE = "https://gateway.example.com";
const TODAY = "2026-10-09";
const empty = { reply: "รับทราบ", changes: [], questions: [], contradictions: [] };

function fakeGateway(answers: unknown[]) {
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const fetch: GatewayFetch = async (url, init) => {
    if (!url.endsWith("/chat")) throw new Error(`unexpected ${url}`);
    requests.push(JSON.parse(String(init?.body)));
    if (answers.length === 0) throw new Error("no more recorded answers");
    const content = answers.shift();
    return new Response(JSON.stringify({ success: true, data: { provider: "openai", model: "gpt-4.1-mini",
      content: typeof content === "string" ? content : JSON.stringify(content), usage: {}, latency_ms: 5 } }));
  };
  return { gateway: createGateway({ baseUrl: BASE, fetch }), requests };
}

// The worked example, Q-001 answered, then one quiz answer marked ผิด → Q-002, open, with no proposed answer.
async function withWrongMark() {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  const pid = p!.id;
  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [...meetingRoom, answerQ001] });
  const quiz = await startQuiz(db, pid);
  const item = await addItem(db, pid, quiz.id, { question: "ห้องใหญ่ต้องให้ใครอนุมัติ", status: "answered", answer: "ไม่ต้องอนุมัติ",
    notInSpec: false, parts: [], model: "openai/gpt-4.1-mini" });
  const marked = await markItem(db, pid, quiz.id, item.id, { mark: "wrong", note: "ผิด" }, { today: TODAY });
  return { db, pid, key: marked.questionKey! };
}
const part = async (db: Db, pid: string, key: string) => (await loadSpec(db, pid)).parts.find((p) => p.key === key)!;
const sets = async (db: Db, pid: string) => db.select().from(changeSets).where(eq(changeSets.projectId, pid));
const caught = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e; } return null; };

test("AC-A1: a quiz-ผิด question answered by id in own words → answered, operator, not stuck; one change set caused by the user row", async () => {
  const { db, pid, key } = await withWrongMark();
  expect((await part(db, pid, key)).body.proposedAnswer).toBeUndefined();
  const before = (await sets(db, pid)).length;
  const text = "ผู้ดูแลห้องเป็นคนอนุมัติห้องที่จุเกินสิบคน";
  const f = fakeGateway([empty]);
  const r = await runRound(db, f.gateway, pid, { answers: [{ key, text }] }, { today: TODAY });
  expect(r.status).toBe("applied");
  const q = await part(db, pid, key);
  expect([q.body.status, q.body.answer, q.origin]).toEqual(["answered", text, { stamp: "operator", date: TODAY }]);
  expect(computeStuck(await loadSpec(db, pid)).map((s) => s.key)).not.toContain(key);
  const after = await sets(db, pid);
  expect(after.length).toBe(before + 1);
  const set = after.find((s) => s.id === r.changeSetId)!;
  expect([set.causeKind, set.causeRef]).toEqual(["message", r.messageIds[0]]);
  // the model saw the answer as "the user answered <key>: <text>"
  expect(f.requests[0]!.messages.map((m) => m.content).join("\n")).toContain(`the user answered ${key}: ${text}`);
});

test("AC-A2: a change quoting ≥ 10 chars of the answer text is operator; a change without a quote is team-proposed", async () => {
  const { db, pid, key } = await withWrongMark();
  const recorded = JSON.parse(readFileSync(GW + "round-a033-answer-quote.json", "utf8"));
  const f = fakeGateway([recorded]);
  const r = await runRound(db, f.gateway, pid, { message: "ต่อเลยครับ",
    answers: [{ key, text: "ผู้ดูแลห้องเป็นคนอนุมัติห้องที่จุเกินสิบคน และต้องตอบภายในหนึ่งวัน" }] }, { today: TODAY });
  expect(r.status).toBe("applied");
  const spec = await loadSpec(db, pid);
  // STEP-004 was stated by a person: changing it needed the user's own words — the answer text supplied them.
  expect(spec.parts.find((p) => p.key === "STEP-004")).toMatchObject({ title: "ผู้ดูแลพิจารณาภายในหนึ่งวัน", origin: { stamp: "operator", date: TODAY } });
  expect(spec.parts.find((p) => p.title === "แจ้งเตือนผู้ดูแล")!.origin).toEqual({ stamp: "team-proposed", date: TODAY });
});

test("AC-A3: park alone → no gateway call, applied with reply null; parked with its reason, not stuck, in the history", async () => {
  const { db, pid, key } = await withWrongMark();
  const originBefore = (await part(db, pid, key)).origin;
  const f = fakeGateway([]);
  const r = await runRound(db, f.gateway, pid, { park: [{ key, reason: "ยังไม่ต้องตัดสินตอนนี้" }] }, { today: TODAY });
  expect(f.requests).toHaveLength(0);
  expect([r.status, r.reply, typeof r.changeSetId]).toEqual(["applied", null, "string"]);
  const q = await part(db, pid, key);
  expect([q.body.status, q.body.parkedReason, q.origin]).toEqual(["parked", "ยังไม่ต้องตัดสินตอนนี้", originBefore]);
  expect(computeStuck(await loadSpec(db, pid)).map((s) => s.key)).not.toContain(key);
  const history = await partHistory(db, pid, key);
  expect((history.at(-1)!.after as { body: { parkedReason?: string } }).body.parkedReason).toBe("ยังไม่ต้องตัดสินตอนนี้");
  // a park without a reason stores no parkedReason
  const { db: db2, pid: pid2, key: key2 } = await withWrongMark();
  await runRound(db2, fakeGateway([]).gateway, pid2, { park: [{ key: key2 }] }, { today: TODAY });
  const q2 = await part(db2, pid2, key2);
  expect([q2.body.status, "parkedReason" in q2.body]).toEqual(["parked", false]);
});

test("AC-A4: a suggestion fills only an open question without one — team-proposed, still open, origin unchanged; others dropped", async () => {
  const { db, pid, key } = await withWrongMark();
  // Q-003: open, already has a proposed answer
  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [{ op: "part.add", ref: "$q", kind: "question", title: "ห้องพอดี 10 คนต้องอนุมัติไหม",
    body: { text: "ห้องพอดี 10 คนต้องอนุมัติไหม", proposedAnswer: "ไม่ต้อง", status: "open" }, origin: { stamp: "team-proposed", date: TODAY } }] });
  const before = await loadSpec(db, pid);
  const originBefore = before.parts.find((p) => p.key === key)!.origin;
  const f = fakeGateway([{ ...empty, suggestions: [
    { key, proposedAnswer: "ผู้ดูแลห้องเป็นคนอนุมัติ" },
    { key: "Q-001", proposedAnswer: "x" }, // answered
    { key: "Q-003", proposedAnswer: "ต้องอนุมัติ" }, // already has one
    { key: "Q-999", proposedAnswer: "x" }, // unknown
    { key: "STEP-004", proposedAnswer: "x" }, // not a question
  ] }]);
  const r = await runRound(db, f.gateway, pid, { message: "มีอะไรต้องตอบอีกไหม" }, { today: TODAY });
  expect(r.status).toBe("applied");
  const after = await loadSpec(db, pid);
  const q = after.parts.find((p) => p.key === key)!;
  expect([q.body.status, q.body.proposedAnswer, q.body.proposedAnswerStamp, q.origin])
    .toEqual(["open", "ผู้ดูแลห้องเป็นคนอนุมัติ", "team-proposed", originBefore]);
  for (const k of ["Q-001", "Q-003", "STEP-004"]) {
    expect(after.parts.find((p) => p.key === k)).toEqual(before.parts.find((p) => p.key === k)!);
  }
  // the model was told which open questions still lack a proposed answer
  expect(f.requests[0]!.messages.map((m) => m.content).join("\n")).toContain(key);
});

test("A-033 validation: a key in two lists, a non-open question, 21 answers, empty text, NUL → 400; nothing written, no call", async () => {
  const { db, pid, key } = await withWrongMark();
  const bad: [string, Parameters<typeof runRound>[3]][] = [
    ["accept + answers", { accept: ["Q-001"], answers: [{ key: "Q-001", text: "x" }] }],
    ["answers + park", { answers: [{ key, text: "ผู้ดูแลห้อง" }], park: [{ key }] }],
    ["twice in answers", { answers: [{ key, text: "a" }, { key, text: "b" }] }],
    ["answered question", { answers: [{ key: "Q-001", text: "ใหม่" }] }],
    ["parked: not a question", { park: [{ key: "STEP-004" }] }],
    ["unknown key", { answers: [{ key: "Q-999", text: "x" }] }],
    ["21 answers", { answers: Array.from({ length: 21 }, () => ({ key, text: "x" })) }],
    ["21 parks", { park: Array.from({ length: 21 }, () => ({ key })) }],
    ["empty text", { answers: [{ key, text: "   " }] }],
    ["text too long", { answers: [{ key, text: "x".repeat(2_001) }] }],
    ["NUL in text", { answers: [{ key, text: "a\u0000b" }] }],
    ["reason too long", { park: [{ key, reason: "x".repeat(501) }] }],
    ["NUL in reason", { park: [{ key, reason: "a\u0000b" }] }],
    ["nothing at all", { answers: [], park: [] }],
  ];
  const setsBefore = (await sets(db, pid)).length;
  for (const [label, input] of bad) {
    const f = fakeGateway([empty]);
    const err = await caught(runRound(db, f.gateway, pid, input, { today: TODAY }));
    expect([label, err instanceof ValidationError, f.requests.length]).toEqual([label, true, 0]);
  }
  expect((await db.select().from(messages).where(eq(messages.projectId, pid))).length).toBe(0);
  expect((await sets(db, pid)).length).toBe(setsBefore);
});

test("A-036: the user row holds the user's own words — answers-only: the answers; message + answers: message first; accept-only / park-only: empty", async () => {
  const { db, pid, key } = await withWrongMark();
  const question = (ref: string, title: string, extra: Record<string, unknown> = {}) => ({ op: "part.add" as const, ref, kind: "question" as const, title,
    body: { text: title, status: "open", ...extra }, origin: { stamp: "operator" as const, date: TODAY } });
  const added = await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [
    question("$a", "จองล่วงหน้าได้กี่วัน"), question("$b", "ยกเลิกได้ก่อนกี่ชั่วโมง"), question("$c", "ห้องเล็กต้องอนุมัติไหม", { proposedAnswer: "ไม่ต้อง" }),
    question("$d", "ต้องแจ้งใครเมื่อยกเลิก"),
  ] });
  const [qa, qb, qc, qd] = ["$a", "$b", "$c", "$d"].map((r) => added.keys[r]!);
  const userRow = async (r: { messageIds: string[] }) =>
    (await db.select().from(messages).where(eq(messages.id, r.messageIds[0]!)))[0]!.content;

  const two = await runRound(db, fakeGateway([empty]).gateway, pid,
    { answers: [{ key, text: "ผู้ดูแลห้องเป็นคนอนุมัติ" }, { key: qa!, text: "เจ็ดวัน" }] }, { today: TODAY });
  expect(await userRow(two)).toBe("ผู้ดูแลห้องเป็นคนอนุมัติ\nเจ็ดวัน");

  const mixed = await runRound(db, fakeGateway([empty]).gateway, pid, { message: "ตอบให้ครับ", answers: [{ key: qb!, text: "สองชั่วโมง" }] }, { today: TODAY });
  expect(await userRow(mixed)).toBe("ตอบให้ครับ\nสองชั่วโมง");

  const accepted = await runRound(db, fakeGateway([empty]).gateway, pid, { accept: [qc!] }, { today: TODAY });
  expect(await userRow(accepted)).toBe("");

  const parked = await runRound(db, fakeGateway([]).gateway, pid, { park: [{ key: qd!, reason: "ยังไม่ต้อง" }] }, { today: TODAY });
  expect(await userRow(parked)).toBe("");
});
