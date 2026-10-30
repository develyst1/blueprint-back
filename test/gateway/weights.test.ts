// REQ-115 / SPEC-112 (TASK-134): each gateway call asks for the model its task weighs (heavy = the project's, light = cheap), a
// light step has one fallback up on the project's model, and every call is recorded. Stub gateways only — no live call.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createApp } from "../../src/app";
import type { Db } from "../../src/db/client";
import { projects } from "../../src/db/schema";
import { createGateway } from "../../src/gateway/client";
import { modelFor } from "../../src/gateway/models";
import { runRound } from "../../src/interview/round";
import { askQuestion, startQuiz } from "../../src/quiz/store";
import { testDb } from "../helpers/db";

const TODAY = "2026-10-30";
const MESSAGE = "ผมอยากได้ฟีเจอร์ใหม่ ช่วยเพิ่มให้หน่อย";
let logged: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  delete process.env.GATEWAY_LIGHT_MODEL;
  logged = [];
  spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
});
afterEach(() => { delete process.env.GATEWAY_LIGHT_MODEL; spy.mockRestore(); });

type Step = string | Error;
// A gateway whose POST /chat answers from a queue (the last answer repeats) and records the model each call asked for.
function stub(contents: Step[]) {
  const asked: string[] = [];
  const gateway = createGateway({
    baseUrl: "https://gateway.example.com", retry: false,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { tier?: string; provider?: string; model?: string };
      asked.push(body.tier ? `tier:${body.tier}` : `${body.provider}/${body.model}`);
      const next = contents[Math.min(asked.length - 1, contents.length - 1)]!;
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify({ success: true, data: { provider: "openai", model: "stub", content: next, usage: {}, latency_ms: 1 } }));
    },
  });
  return { gateway, asked };
}
const reply = (changes: unknown[]) => JSON.stringify({ reply: "บันทึกให้แล้วครับ", changes, questions: [], contradictions: [] });
const bad = (kind = "feature") =>
  ({ change: { op: "part.add", ref: "$x", kind, title: "ฟีเจอร์ใหม่", body: {} }, saidBy: "user", quote: MESSAGE, sure: true });
const good = { change: { op: "part.add", ref: "$w", kind: "work", title: "งานใหม่", body: {} }, saidBy: "user", quote: MESSAGE, sure: true };
const REFUSED = reply([bad()]);        // one item the server refuses (unknown kind)
const FIXED = reply([good]);           // the corrected answer
const NOT_JSON = "ขออภัยครับ ตอบเป็นข้อความธรรมดา";

async function project(model = "tier:medium"): Promise<{ db: Db; pid: string }> {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้อง", model }).returning();
  return { db, pid: p!.id };
}
const pick = (c: { step: string; weight: string; asked: string; fallback: boolean; ok: boolean; reason: string | null }) =>
  [c.step, c.weight, c.asked, c.fallback, c.ok, c.reason];

test("AC-1: the first answer refuses 1 item → the first goes to the project's model, the correction to tier:small; both recorded", async () => {
  const { db, pid } = await project();
  const { gateway, asked } = stub([REFUSED, FIXED]);
  const round = await runRound(db, gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, asked]).toEqual(["applied", ["tier:medium", "tier:small"]]);
  expect(round.calls!.map(pick)).toEqual([
    ["first", "heavy", "tier:medium", false, true, null],
    ["correction", "light", "tier:small", false, true, null],
  ]);
  expect(round.calls![0]).toMatchObject({ model: "openai/stub" });
  // the same list is on the bot row and in the chat list
  const res = await createApp(db).request(`/v1/projects/${pid}/messages`);
  const rows = (await res.json()) as { role: string; roundCalls: unknown }[];
  expect(rows.find((r) => r.role === "bot")!.roundCalls).toEqual(round.calls);
  expect(rows.find((r) => r.role === "user")!.roundCalls).toBeNull();
});

test("AC-2: a quiz answer asks tier:small; the item has 1 call answer/light", async () => {
  const { db, pid } = await project();
  const quiz = await startQuiz(db, pid);
  const { gateway, asked } = stub([JSON.stringify({ answer: "ไม่มีในสเปก", parts: [], notInSpec: true })]);
  const item = await askQuestion(db, gateway, pid, quiz.id, "ใครอนุมัติ");
  expect([item.status, asked]).toEqual(["answered", ["tier:small"]]);
  expect(item.calls!.map(pick)).toEqual([["answer", "light", "tier:small", false, true, null]]);
});

// AC-3 ×3: exactly 1 extra call on the project's model, recorded fallback:true — never 2.
test("AC-3 (transport): the light correction fails → exactly 1 fallback on the project's model", async () => {
  const { db, pid } = await project();
  const { gateway, asked } = stub([REFUSED, new Error("down"), FIXED]);
  const round = await runRound(db, gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, asked]).toEqual(["applied", ["tier:medium", "tier:small", "tier:medium"]]);
  expect(round.calls!.map(pick)).toEqual([
    ["first", "heavy", "tier:medium", false, true, null],
    ["correction", "light", "tier:small", false, false, "network"],
    ["correction", "light", "tier:medium", true, true, null],
  ]);
});

test("AC-3 (unreadable): the light correction is not our JSON → exactly 1 fallback", async () => {
  const { db, pid } = await project();
  const { gateway, asked } = stub([REFUSED, NOT_JSON, FIXED]);
  const round = await runRound(db, gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, asked]).toEqual(["applied", ["tier:medium", "tier:small", "tier:medium"]]);
  expect(round.calls!.map(pick)).toEqual([
    ["first", "heavy", "tier:medium", false, true, null],
    ["correction", "light", "tier:small", false, false, "protocol"],
    ["correction", "light", "tier:medium", true, true, null],
  ]);
});

test("AC-3 (still refusing): the light correction still refuses → 1 fallback; its plan is used because it refuses fewer", async () => {
  const { db, pid } = await project();
  const { gateway, asked } = stub([REFUSED, REFUSED, FIXED]);
  const round = await runRound(db, gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, round.refused, asked]).toEqual(["applied", null, ["tier:medium", "tier:small", "tier:medium"]]);
  expect(round.calls!.map(pick)).toEqual([
    ["first", "heavy", "tier:medium", false, true, null],
    ["correction", "light", "tier:small", false, true, null], // readable — it is the refusal that sends it up
    ["correction", "light", "tier:medium", true, true, null],
  ]);
});

test("AC-3 (never two): a fallback that fails too ends the step — still 1 extra call, the first answer is pruned as before", async () => {
  const { db, pid } = await project();
  const { gateway, asked } = stub([REFUSED, NOT_JSON]);
  const round = await runRound(db, gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, round.reason]).toEqual(["changes_rejected", "protocol"]);
  expect(asked).toEqual(["tier:medium", "tier:small", "tier:medium"]);
  expect(round.calls!.filter((c) => c.fallback)).toHaveLength(1);
});

test("AC-3 (quiz): an unreadable light answer → exactly 1 fallback on the project's model, recorded", async () => {
  const { db, pid } = await project();
  const quiz = await startQuiz(db, pid);
  const { gateway, asked } = stub([NOT_JSON, JSON.stringify({ answer: "ห้องใหญ่ต้องอนุมัติ", parts: [], notInSpec: false })]);
  const item = await askQuestion(db, gateway, pid, quiz.id, "ใครอนุมัติ");
  expect([item.status, asked]).toEqual(["answered", ["tier:small", "tier:medium"]]);
  expect(item.calls!.map(pick)).toEqual([
    ["answer", "light", "tier:small", false, false, "protocol"],
    ["answer", "light", "tier:medium", true, true, null],
  ]);
});

test("AC-4: GATEWAY_LIGHT_MODEL names the light model on the next call; unset → tier:small; invalid → the project's model, log without the value", async () => {
  expect(modelFor("light", "tier:medium")).toBe("tier:small");
  process.env.GATEWAY_LIGHT_MODEL = "deepseek/deepseek-chat";
  const { db, pid } = await project();
  const set = stub([REFUSED, FIXED]);
  await runRound(db, set.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect(set.asked).toEqual(["tier:medium", "deepseek/deepseek-chat"]);
  delete process.env.GATEWAY_LIGHT_MODEL;
  const unset = stub([REFUSED, FIXED]);
  await runRound(db, unset.gateway, pid, { message: MESSAGE + " อีกครั้ง" }, { today: TODAY });
  expect(unset.asked).toEqual(["tier:medium", "tier:small"]);
  process.env.GATEWAY_LIGHT_MODEL = "not-a-model-id-SECRET";
  const invalid = stub([REFUSED, FIXED]);
  const round = await runRound(db, invalid.gateway, pid, { message: MESSAGE + " อีกที" }, { today: TODAY });
  expect(invalid.asked).toEqual(["tier:medium", "tier:medium"]); // the project's model, and so no fallback
  expect(round.calls!.some((c) => c.fallback)).toBe(false);
  expect(logged).toContain("[gateway] GATEWAY_LIGHT_MODEL invalid — using the project's model");
  expect(logged.join("\n")).not.toContain("SECRET");
});

test("a project on tier:small: a light step has no fallback — an unreadable re-ask is 1 call, the round ends protocol", async () => {
  const { db, pid } = await project("tier:small");
  const { gateway, asked } = stub([NOT_JSON]);
  const round = await runRound(db, gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, round.reason]).toEqual(["bot_could_not_answer", "protocol"]);
  expect(asked).toEqual(["tier:small", "tier:small"]); // the first call + the one re-ask, nothing repeated
  expect(round.calls!.map(pick)).toEqual([
    ["first", "heavy", "tier:small", false, false, "protocol"],
    ["reask", "light", "tier:small", false, false, "protocol"],
  ]);
  // …and the failed bot row carries the record too
  const rows = (await (await createApp(db).request(`/v1/projects/${pid}/messages`)).json()) as { role: string; roundCalls: unknown }[];
  expect(rows.find((r) => r.role === "bot")!.roundCalls).toEqual(round.calls);
});
