// SPEC-A-004 rule 4: answering a quiz question from the spec only — recorded gateway answers, no live call.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messages, projects } from "../../src/db/schema";
import { createGateway, type GatewayFetch } from "../../src/gateway/client";
import { QUIZ_CONTEXT_CAP, specBlock } from "../../src/quiz/answer";
import { askQuestion, markItem, readQuiz, startQuiz } from "../../src/quiz/store";
import { addFile } from "../../src/sources/service";
import { NotMarkable } from "../../src/spec/errors";
import { applyChangeSet, loadSpec } from "../../src/spec/store";
import type { Change } from "../../src/spec/types";
import { meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";

const GW = new URL("../fixtures/gateway/", import.meta.url).pathname;
const BASE = "https://gateway.example.com";
const dirs: string[] = [];
let logged: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => { logged = []; spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); }); });
afterEach(() => { spy.mockRestore(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Answer = () => Response;
const said = (content: unknown): Answer => () => new Response(JSON.stringify({ success: true,
  data: { provider: "openai", model: "gpt-4.1-mini", content: typeof content === "string" ? content : JSON.stringify(content), usage: {}, latency_ms: 5 } }));
const recording = (name: string) => JSON.parse(readFileSync(GW + name, "utf8"));
function fake(answers: Answer[]) {
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const fetch: GatewayFetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const a = answers.shift();
    if (!a) throw new Error("no more answers");
    return a();
  };
  return { gateway: createGateway({ baseUrl: BASE, fetch }), requests };
}
const text = (r: { messages: { content: string }[] }) => r.messages.map((m) => m.content).join("\n");

async function project() {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: meetingRoom });
  return { db, pid: p!.id };
}

test("AC-1: answered from the spec only, naming the parts it used", async () => {
  const { db, pid } = await project();
  const dir = mkdtempSync(join(tmpdir(), "blueprint-quiz-"));
  dirs.push(dir);
  await addFile(db, dir, pid, { name: "notes.txt", bytes: readFileSync(new URL("../fixtures/sources/notes.txt", import.meta.url).pathname),
    origin: { stamp: "operator", date: "2026-10-09" } });
  await db.insert(messages).values({ projectId: pid, role: "user", content: "ข้อความแชตที่ไม่ควรถูกส่ง", model: "tier:medium", creativity: 0.5 });
  const quiz = await startQuiz(db, pid);
  const f = fake([said(recording("quiz-ac1.json"))]);
  const item = await askQuestion(db, f.gateway, pid, quiz.id, "ห้องใหญ่ต้องให้ใครอนุมัติ");
  expect(item).toMatchObject({ status: "answered", notInSpec: false, parts: ["STEP-004", "DEC-001"] });
  expect(item.answer).toContain("ผู้ดูแลห้องอนุมัติ");
  const sent = text(f.requests[0]!);
  expect(sent).toContain("ห้องที่จุเกิน 10 คนต้องให้ผู้ดูแลอนุมัติ"); // DEC-001's rule
  expect(sent).not.toContain("ผู้ดูแลห้องต้องตอบภายใน 24 ชั่วโมง"); // source text
  expect(sent).not.toContain("ข้อความแชตที่ไม่ควรถูกส่ง"); // a chat message
  expect(sent).not.toContain("open_question"); // the stuck list
});

test("AC-2: not in the spec → notInSpec, and no parts kept", async () => {
  const { db, pid } = await project();
  const quiz = await startQuiz(db, pid);
  const item = await askQuestion(db, fake([said(recording("quiz-ac2.json"))]).gateway, pid, quiz.id, "ราคาห้องเท่าไร");
  expect(item).toMatchObject({ status: "answered", notInSpec: true, parts: [] });
});

test("AC-10: every gateway failure leaves a failed item that cannot be marked", async () => {
  const throws: Answer = () => { throw new Error("down"); };
  const http500: Answer = () => new Response(readFileSync(GW + "chat-500.json", "utf8"), { status: 500 });
  const notJson: Answer = () => new Response(readFileSync(GW + "chat-not-json.txt", "utf8"));
  const blank: Answer = () => new Response(readFileSync(GW + "chat-empty-content.json", "utf8"));
  const notProtocol = said("ห้องใหญ่ต้องอนุมัติครับ");
  // transport failures: the client's call + its retry (2) · not our protocol: one more call (2)
  const cases: [string, Answer[], number, string][] = [
    ["gateway down", [throws, throws], 2, "network"], ["HTTP 500", [http500, http500], 2, "http_500"],
    ["not JSON", [notJson, notJson], 2, "not_json"], ["empty content", [blank, blank], 2, "empty_content"],
    ["not our protocol", [notProtocol, notProtocol], 2, "protocol"],
  ];
  for (const [label, answers, calls, reason] of cases) {
    logged = [];
    const { db, pid } = await project();
    const quiz = await startQuiz(db, pid);
    const f = fake(answers);
    const item = await askQuestion(db, f.gateway, pid, quiz.id, "ใครอนุมัติห้องใหญ่");
    expect([label, item.status, item.answer, f.requests.length]).toEqual([label, "failed", null, calls]);
    expect(logged).toEqual([`[quiz] failed reason=${reason}`]);
    let err: unknown;
    try { await markItem(db, pid, quiz.id, item.id, { mark: "right" }, { today: "2026-10-09" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NotMarkable);
    expect((await readQuiz(db, pid, quiz.id)).marked).toBe(0);
  }
});

test("unknown part keys in a reply are dropped", async () => {
  const { db, pid } = await project();
  const quiz = await startQuiz(db, pid);
  const item = await askQuestion(db, fake([said({ answer: "ที่ขั้นตอน 04", parts: ["STEP-004", "STEP-999", "nonsense"], notInSpec: false })]).gateway,
    pid, quiz.id, "ใครอนุมัติห้องใหญ่");
  expect(item.parts).toEqual(["STEP-004"]);
});

test("the 24 000-character cap holds on a large spec", async () => {
  const { db, pid } = await project();
  // A large invented spec: 400 more steps with long titles and bodies.
  const extra: Change[] = Array.from({ length: 400 }, (_, i) => ({ op: "part.add", ref: `$s${i}`, kind: "step",
    title: `ขั้นตอนตัวอย่างที่ ${i} ที่มีชื่อยาวพอสมควรเพื่อทดสอบเพดาน`, body: { ends: false }, origin: { stamp: "operator", date: "2026-10-09" } }) as Change);
  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: extra });
  const spec = await loadSpec(db, pid);
  const full = specBlock(spec.parts, spec.links, Infinity).length;
  const capped = specBlock(spec.parts, spec.links).length;
  console.log(`quiz context: uncapped ${full} chars → capped ${capped} (cap ${QUIZ_CONTEXT_CAP})`);
  expect(full).toBeGreaterThan(QUIZ_CONTEXT_CAP);
  expect(capped).toBeLessThanOrEqual(QUIZ_CONTEXT_CAP);
  const quiz = await startQuiz(db, pid);
  const f = fake([said(recording("quiz-ac1.json"))]);
  await askQuestion(db, f.gateway, pid, quiz.id, "ใครอนุมัติห้องใหญ่");
  expect(f.requests[0]!.messages.find((m) => m.content.includes("STEP-001"))!.content.length).toBeLessThanOrEqual(QUIZ_CONTEXT_CAP + 200);
});
