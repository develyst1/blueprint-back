// The interview round (REQ-003 R4) on recorded gateway answers only — no live call (DECISIONS 2026-10-09 l.79).
import { afterEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../../src/db/client";
import { changeSets, messages, projects } from "../../src/db/schema";
import { createGateway, type GatewayFetch } from "../../src/gateway/client";
import { CAPS, HEADINGS_MAX, HISTORY, SYSTEM_PROMPT } from "../../src/interview/context";
import { runRound } from "../../src/interview/round";
import { addAmendment } from "../../src/seam/amend";
import { addFile } from "../../src/sources/service";
import { applyChangeSet, loadSpec, undoChangeSet } from "../../src/spec/store";
import { computeStuck } from "../../src/spec/stuck";
import type { Change } from "../../src/spec/types";
import { meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";

const GW = new URL("../fixtures/gateway/", import.meta.url).pathname;
const SRC = new URL("../fixtures/sources/", import.meta.url).pathname;
const BASE = "https://gateway.example.com";
const TODAY = "2026-10-09";
const RULE = "ห้องที่จุเกิน 10 คนต้องให้ผู้ดูแลอนุมัติ";
const operator = { stamp: "operator", date: "2026-10-08" } as const;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Answer = string | (() => Response);
const recording = (name: string) => readFileSync(GW + name, "utf8");
// A gateway answer whose content is `content` (a protocol object, or raw text).
const said = (content: unknown, model = "gpt-4.1-mini"): Answer => () => new Response(JSON.stringify({
  success: true,
  data: { provider: "openai", model, content: typeof content === "string" ? content : JSON.stringify(content), usage: {}, latency_ms: 5 },
}));

// A fake gateway: POST /chat answers from a queue; every request body is kept.
function fakeGateway(answers: Answer[]) {
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const fetch: GatewayFetch = async (url, init) => {
    if (!url.endsWith("/chat")) throw new Error(`unexpected ${url}`);
    requests.push(JSON.parse(String(init?.body)));
    const next = answers.shift();
    if (next === undefined) throw new Error("no more recorded answers");
    return typeof next === "string" ? new Response(next) : next();
  };
  return { gateway: createGateway({ baseUrl: BASE, fetch }), requests };
}
const allText = (req: { messages: { content: string }[] }) => req.messages.map((m) => m.content).join("\n");

async function project(withExample = true) {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  if (withExample) await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: meetingRoom });
  const dir = mkdtempSync(join(tmpdir(), "blueprint-round-"));
  dirs.push(dir);
  return { db, pid: p!.id, dir };
}
const apply = (db: Db, pid: string, changes: Change[]) => applyChangeSet(db, pid, { cause: meetingRoomCause, changes });
const changeSetCount = async (db: Db, pid: string) => (await db.select().from(changeSets).where(eq(changeSets.projectId, pid))).length;
const empty = { reply: "รับทราบ", changes: [], questions: [], contradictions: [] };

test("AC-1: a change said by a source carries that source's stamp and origin.sourceId", async () => {
  const { db, pid, dir } = await project();
  const src = await addFile(db, dir, pid, { name: "notes.txt", bytes: readFileSync(SRC + "notes.txt"),
    origin: { stamp: "customer-asked", date: "2026-10-01", channel: "LINE" } });
  const { gateway } = fakeGateway([said({ ...empty, changes: [
    { change: { op: "part.add", ref: "$r", kind: "role", title: "ฝ่ายอาคาร", body: {} }, saidBy: { source: src.id },
      quote: "ผู้ดูแลห้องต้องตอบภายใน 24 ชั่วโมง", sure: true },
  ] })]);
  const round = await runRound(db, gateway, pid, { message: "อ่านบันทึกการประชุมแล้วเพิ่มให้หน่อย" }, { today: TODAY });
  expect(round.status).toBe("applied");
  const role = (await loadSpec(db, pid)).parts.find((p) => p.title === "ฝ่ายอาคาร")!;
  expect(role.origin).toEqual({ stamp: "customer-asked", date: TODAY, channel: "LINE", sourceId: src.id });
});

test("AC-2: a failed source is named missing in the request and listed in failedSources; the round still runs", async () => {
  const { db, pid, dir } = await project();
  const bad = await addFile(db, dir, pid, { name: "corrupt.pdf", bytes: readFileSync(SRC + "corrupt.pdf"), origin: operator });
  expect(bad.status).toBe("failed");
  const fake = fakeGateway([said(empty)]);
  const round = await runRound(db, fake.gateway, pid, { message: "สรุปให้หน่อย" }, { today: TODAY });
  expect(round.status).toBe("no_changes");
  expect(round.failedSources).toEqual([bad.id]);
  expect(allText(fake.requests[0]!)).toContain(`"corrupt.pdf"`);
  expect(allText(fake.requests[0]!)).toContain("unreadable_pdf");
});

test("AC-4 (a): the request carries the source excerpt that answers the user's question", async () => {
  const { db, pid, dir } = await project();
  const src = await addFile(db, dir, pid, { name: "rooms.pdf", bytes: readFileSync(SRC + "rooms.pdf"), origin: operator });
  const fake = fakeGateway([said(empty)]);
  await runRound(db, fake.gateway, pid, { message: "ใครอนุมัติห้องใหญ่" }, { today: TODAY });
  const text = allText(fake.requests[0]!);
  expect(text).toContain(RULE);
  expect(text).toContain(`[source ${src.id} "rooms.pdf"]`);
});

test("AC-4 (b): a model question equal to an existing one (spaces, case) is dropped", async () => {
  const { db, pid } = await project();
  await apply(db, pid, [{ op: "part.add", ref: "$q", kind: "question", title: "Who approves  BIG rooms?",
    body: { text: "Who approves  BIG rooms?", proposedAnswer: "the admin" }, origin: operator }]);
  const before = (await loadSpec(db, pid)).parts.filter((p) => p.kind === "question").length;
  const { gateway } = fakeGateway([said({ ...empty, questions: [
    { text: " who approves big   rooms? ", proposedAnswer: "the admin", cases: [] },
    { text: "ห้องเล็กต้องจองล่วงหน้ากี่วัน", proposedAnswer: "1 วัน", cases: [] },
  ] })]);
  const round = await runRound(db, gateway, pid, { message: "ถามต่อได้เลย" }, { today: TODAY });
  expect(round.questions).toHaveLength(1);
  expect((await loadSpec(db, pid)).parts.filter((p) => p.kind === "question").length).toBe(before + 1);
});

test("AC-4 (c): every question the round creates has a non-empty proposedAnswer", async () => {
  const { db, pid } = await project();
  const fake = fakeGateway([
    said({ ...empty, questions: [{ text: "ห้องประชุมเปิดกี่โมง", proposedAnswer: "", cases: [] }] }),
    said({ ...empty, questions: [{ text: "ห้องประชุมเปิดกี่โมง", proposedAnswer: "8 โมงเช้า", cases: [] }] }),
  ]);
  const round = await runRound(db, fake.gateway, pid, { message: "ถามต่อ" }, { today: TODAY });
  expect(round.status).toBe("applied");
  expect(fake.requests).toHaveLength(2); // the empty answer went to the one correction call
  for (const q of (await loadSpec(db, pid)).parts.filter((p) => p.kind === "question")) {
    expect(String(q.body.proposedAnswer ?? "").trim().length).toBeGreaterThan(0);
  }
});

test("AC-5: two accepted questions + three changes are one change set; undo restores the spec", async () => {
  const { db, pid } = await project();
  await apply(db, pid, [{ op: "part.add", ref: "$q", kind: "question", title: "ยกเลิกได้ไหม",
    body: { text: "ยกเลิกได้ไหม", proposedAnswer: "ได้ก่อน 1 ชั่วโมง" }, origin: operator }]);
  const before = await loadSpec(db, pid);
  const setsBefore = await changeSetCount(db, pid);
  const { gateway } = fakeGateway([recording("round-ac5.json")].map((c) => said(JSON.parse(c))));
  const round = await runRound(db, gateway, pid, {
    message: "เพิ่มขั้นตอนแจ้งเตือนผู้ดูแลเมื่อมีคำขอ และแก้ชื่อขั้นที่ 2 เป็น เลือกห้องและช่วงเวลา", accept: ["Q-001", "Q-002"],
  }, { today: TODAY });
  expect(round.status).toBe("applied");
  expect(await changeSetCount(db, pid)).toBe(setsBefore + 1);
  const after = await loadSpec(db, pid);
  expect(after.parts.find((p) => p.key === "Q-001")!.body).toMatchObject({ status: "answered", answer: "ยกเลิกอัตโนมัติและแจ้งพนักงาน" });
  expect(after.parts.find((p) => p.key === "Q-002")!.body).toMatchObject({ status: "answered", answer: "ได้ก่อน 1 ชั่วโมง" });
  expect(after.parts.find((p) => p.key === "STEP-007")!.origin).toEqual({ stamp: "operator", date: TODAY });
  expect(after.parts.find((p) => p.key === "STEP-002")!.origin).toEqual({ stamp: "operator", date: TODAY });
  await undoChangeSet(db, pid, round.changeSetId!);
  expect(await loadSpec(db, pid)).toEqual(before);
});

test("AC-6: an invalid change → nothing applied, one correction call with the error; still invalid → changes_rejected", async () => {
  const { db, pid } = await project();
  const before = await loadSpec(db, pid);
  const bad = { ...empty, changes: [
    { change: { op: "part.add", ref: "$r", kind: "role", title: "ฝ่ายบัญชี", body: {} }, saidBy: "user", sure: true },
    { change: { op: "link.add", kind: "shows", from: "STEP-001", to: "DATA-001" }, saidBy: "user", sure: true },
  ] };
  const fake = fakeGateway([said(bad), said(bad)]);
  const round = await runRound(db, fake.gateway, pid, { message: "เพิ่มให้หน่อย" }, { today: TODAY });
  expect(round.status).toBe("changes_rejected");
  expect(round.changeSetId).toBeNull();
  expect(fake.requests).toHaveLength(2);
  expect(allText(fake.requests[1]!)).toContain("shows");
  expect(allText(fake.requests[1]!)).toMatch(/cannot start at a step/);
  expect(await loadSpec(db, pid)).toEqual(before);

  const { db: db2, pid: pid2 } = await project();
  const fixed = { ...empty, changes: [bad.changes[0]] };
  const fake2 = fakeGateway([said(bad), said(fixed)]);
  const ok = await runRound(db2, fake2.gateway, pid2, { message: "เพิ่มให้หน่อย" }, { today: TODAY });
  expect([ok.status, fake2.requests.length]).toEqual(["applied", 2]);
});

test("AC-7: an unsure change becomes a question and is not applied", async () => {
  const { db, pid } = await project();
  const { gateway } = fakeGateway([said({ ...empty, changes: [
    { change: { op: "part.add", ref: "$r", kind: "role", title: "ฝ่ายไอที", body: {} }, saidBy: "inferred", sure: false,
      ifUnsure: { text: "ฝ่ายไอทีมีส่วนในการจองห้องไหม", proposedAnswer: "ไม่มี", cases: [] } },
  ] })]);
  const round = await runRound(db, gateway, pid, { message: "ใครเกี่ยวข้องบ้าง" }, { today: TODAY });
  const spec = await loadSpec(db, pid);
  expect(spec.parts.some((p) => p.title === "ฝ่ายไอที")).toBe(false);
  const q = spec.parts.find((p) => p.key === round.questions[0])!;
  expect(q.body).toMatchObject({ text: "ฝ่ายไอทีมีส่วนในการจองห้องไหม", proposedAnswer: "ไม่มี", status: "open" });
  expect(q.origin.stamp).toBe("team-proposed");
});

test("AC-8: a recorded contradiction with DEC-001 is stuck with both keys", async () => {
  const { db, pid, dir } = await project();
  const src = await addFile(db, dir, pid, { name: "notes.txt", bytes: readFileSync(SRC + "notes.txt"), origin: operator });
  const content = recording("round-ac8-contradiction.json").replace("SOURCE_ID", src.id);
  const { gateway } = fakeGateway([said(JSON.parse(content))]);
  const round = await runRound(db, gateway, pid, { message: "เทียบเอกสารให้หน่อย" }, { today: TODAY });
  expect(round.contradictions).toEqual(["CON-001"]);
  const item = computeStuck(await loadSpec(db, pid)).find((i) => i.kind === "contradiction")!;
  expect(item).toMatchObject({ key: "CON-001", between: ["DEC-001", "STEP-004"] });
});

test("AC-10: every gateway failure ends bot_could_not_answer with the spec unchanged", async () => {
  const throws: Answer = () => { throw new Error("down"); };
  const http500: Answer = () => new Response(recording("chat-500.json"), { status: 500 });
  const notJson: Answer = () => new Response(recording("chat-not-json.txt"));
  const blank: Answer = () => new Response(recording("chat-empty-content.json"));
  const notProtocol = said("ขอโทษครับ ตอบเป็นข้อความธรรมดา");
  // [case, answers queued, fetch calls expected]: transport failures = the client's 1 call + its 1 retry, no protocol retry;
  // a reply that is not our protocol = the round call + one protocol retry (each succeeds at transport level).
  const cases: [string, Answer[], number][] = [
    ["gateway down", [throws, throws], 2], ["HTTP 500", [http500, http500], 2], ["not JSON", [notJson, notJson], 2],
    ["empty content", [blank, blank], 2], ["not our protocol", [notProtocol, notProtocol], 2],
  ];
  for (const [label, answers, calls] of cases) {
    const { db, pid } = await project();
    const before = await loadSpec(db, pid);
    const fake = fakeGateway(answers);
    const round = await runRound(db, fake.gateway, pid, { message: "สวัสดี" }, { today: TODAY });
    expect([label, round.status, round.reply, round.changeSetId, fake.requests.length])
      .toEqual([label, "bot_could_not_answer", null, null, calls]);
    expect(await loadSpec(db, pid)).toEqual(before);
  }
});

test("AC-11: with 60 stored messages the request holds only the last 6, and its size is bounded", async () => {
  const { db, pid } = await project();
  for (let i = 1; i <= 60; i++) {
    await db.insert(messages).values({ projectId: pid, role: i % 2 ? "user" : "bot", content: `ข้อความที่ ${i} ${"ก".repeat(500)}`,
      model: "tier:medium", creativity: 0.5, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) }); // well before now
  }
  const fake = fakeGateway([said(empty)]);
  await runRound(db, fake.gateway, pid, { message: "ต่อเลย" }, { today: TODAY });
  const sent = fake.requests[0]!.messages;
  const history = sent.filter((m) => m.role === "user" || m.role === "assistant").slice(0, -1);
  expect(history.map((m) => m.content.split(" ").slice(0, 2).join(" "))).toEqual(
    [55, 56, 57, 58, 59, 60].map((i) => `ข้อความที่ ${i}`));
  expect(history).toHaveLength(HISTORY);
  const bound = CAPS.spec + CAPS.stuck + CAPS.decisions + CAPS.excerpts + HEADINGS_MAX + SYSTEM_PROMPT.length
    + history.reduce((n, m) => n + m.content.length, 0) + "ต่อเลย".length + 200;
  expect(allText(fake.requests[0]!).length).toBeLessThanOrEqual(bound);
});

test("at most 5 new questions per round, ranked by what they are about", async () => {
  const { db, pid } = await project();
  const { gateway } = fakeGateway([said(JSON.parse(recording("round-seven-questions.json")))]);
  const round = await runRound(db, gateway, pid, { message: "ถามมาเลย" }, { today: TODAY });
  expect(round.questions).toHaveLength(5);
  const spec = await loadSpec(db, pid);
  const aboutOf = (key: string) => spec.links.find((l) => l.kind === "about" && l.fromKey === key)?.toKey;
  // work, step, screen, api, then the rest (data before system: the model's order) — the no-about one is dropped.
  expect(round.questions.map(aboutOf)).toEqual(["WRK-001", "STEP-002", "SCR-001", "API-001", "DATA-001"]);
});

test("review: correction text names the model's own item; a NUL in the reply is not our protocol", async () => {
  const { db, pid } = await project();
  const bad = { ...empty, changes: [
    { change: { op: "part.add", ref: "$r", kind: "role", title: "ฝ่ายบัญชี", body: {} }, saidBy: "user", sure: true },
    { change: { op: "link.add", kind: "shows", from: "STEP-001", to: "DATA-001" }, saidBy: "user", sure: true },
  ] };
  const fake = fakeGateway([said(bad), said(bad)]);
  await runRound(db, fake.gateway, pid, { message: "เพิ่ม", accept: ["Q-001"] }, { today: TODAY });
  const correction = fake.requests[1]!.messages.at(-1)!.content;
  expect(correction).toContain("changes[1]"); // not the position in the server's combined list (accept comes first there)

  const { db: db2, pid: pid2 } = await project();
  const before = await loadSpec(db2, pid2);
  const nul = said(`{"reply":"ok\\u0000","changes":[],"questions":[],"contradictions":[]}`);
  const fake2 = fakeGateway([nul, nul]);
  const round = await runRound(db2, fake2.gateway, pid2, { message: "สวัสดี" }, { today: TODAY });
  expect([round.status, fake2.requests.length]).toEqual(["bot_could_not_answer", 2]);
  expect(await loadSpec(db2, pid2)).toEqual(before);
});

test("review: an unexpected error leaves no orphan user message", async () => {
  const { db, pid } = await project();
  await db.update(projects).set({ model: "not-a-model-id" }).where(eq(projects.id, pid)); // a stored value the client refuses
  const { gateway } = fakeGateway([said(empty)]);
  await expect(runRound(db, gateway, pid, { message: "สวัสดี" }, { today: TODAY })).rejects.toThrow();
  expect(await db.select().from(messages).where(eq(messages.projectId, pid))).toEqual([]);
});

test("A-023 step 1: if the bot row cannot be written, the change set is not kept; the same round again applies once", async () => {
  const { db, pid } = await project();
  const before = await loadSpec(db, pid);
  const sets = await changeSetCount(db, pid);
  // Test-only fault: the database refuses every bot row.
  await db.execute(sql.raw(`CREATE FUNCTION no_bot_rows() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.role = 'bot' THEN RAISE EXCEPTION 'forced bot row failure'; END IF; RETURN NEW; END $$`));
  await db.execute(sql.raw("CREATE TRIGGER no_bot_rows BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION no_bot_rows()"));
  const adds = { ...empty, changes: [{ change: { op: "part.add", ref: "$r", kind: "role", title: "ฝ่ายอาคาร", body: {} }, saidBy: "inferred", sure: true }] };
  const first = fakeGateway([said(adds)]);
  await expect(runRound(db, first.gateway, pid, { message: "เพิ่มฝ่ายอาคาร" }, { today: TODAY })).rejects.toThrow();
  expect(await loadSpec(db, pid)).toEqual(before);
  expect(await changeSetCount(db, pid)).toBe(sets);
  expect(await db.select().from(messages).where(eq(messages.projectId, pid))).toEqual([]);

  await db.execute(sql.raw("DROP TRIGGER no_bot_rows ON messages"));
  const again = fakeGateway([said(adds)]);
  const round = await runRound(db, again.gateway, pid, { message: "เพิ่มฝ่ายอาคาร" }, { today: TODAY });
  expect(round.status).toBe("applied");
  expect(await changeSetCount(db, pid)).toBe(sets + 1);
  expect((await loadSpec(db, pid)).parts.filter((p) => p.title === "ฝ่ายอาคาร")).toHaveLength(1);
});

test("A-025 step 5: question de-dup ignores all whitespace (Thai); a new question's text is trimmed and collapsed", async () => {
  const { db, pid } = await project();
  await apply(db, pid, [{ op: "part.add", ref: "$q", kind: "question", title: "ใครอนุมัติห้องใหญ่",
    body: { text: "ใครอนุมัติห้องใหญ่", proposedAnswer: "ผู้ดูแล" }, origin: operator }]);
  const { gateway } = fakeGateway([said({ ...empty, questions: [
    { text: "  ใครอนุมัติ   ห้องใหญ่ ", proposedAnswer: "ผู้ดูแล", cases: [] },
    { text: "  ห้องเล็ก   จองล่วงหน้ากี่วัน ", proposedAnswer: "1 วัน", cases: [] },
  ] })]);
  const round = await runRound(db, gateway, pid, { message: "ถามต่อ" }, { today: TODAY });
  expect(round.questions).toHaveLength(1);
  const kept = (await loadSpec(db, pid)).parts.find((p) => p.key === round.questions[0])!;
  expect([kept.title, kept.body.text]).toEqual(["ห้องเล็ก จองล่วงหน้ากี่วัน", "ห้องเล็ก จองล่วงหน้ากี่วัน"]);
});

test("A-029: a caw amendment in the history reaches the next round as a user turn prefixed [CAW <from>]", async () => {
  const { db, pid } = await project();
  await addAmendment(db, pid, { from: "card-17", request: "ขอเพิ่มการแจ้งเตือนทางอีเมล", about: ["STEP-004"] });
  const f = fakeGateway([said(empty)]);
  await runRound(db, f.gateway, pid, { message: "ต่อเลย" }, { today: TODAY });
  const turns = f.requests[0]!.messages.filter((m) => m.role === "user");
  expect(turns.map((m) => m.content)).toContain("[CAW card-17] about: STEP-004\nขอเพิ่มการแจ้งเตือนทางอีเมล");
});
