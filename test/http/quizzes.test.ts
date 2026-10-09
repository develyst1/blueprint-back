// The quiz routes (SPEC-A-004 § API) on recorded gateway answers — no live call.
import { expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { createGateway, type GatewayFetch } from "../../src/gateway/client";
import { meetingRoom } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";

const BASE = "https://gateway.example.com";
const reply = { answer: "ผู้ดูแลห้องอนุมัติ ที่ขั้นตอน 04", parts: ["STEP-004"], notInSpec: false };

async function api() {
  const fetch: GatewayFetch = async () => new Response(JSON.stringify({ success: true,
    data: { provider: "openai", model: "gpt-4.1-mini", content: JSON.stringify(reply), usage: {}, latency_ms: 5 } }));
  const app = createApp(await testDb(), { gateway: createGateway({ baseUrl: BASE, fetch }) });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const pid = (await call("POST", "/v1/projects", { name: "จองห้องประชุม" })).body.id as string;
  await call("POST", `/v1/projects/${pid}/change-sets`, { cause: { kind: "operator" }, changes: meetingRoom });
  return { call, pid };
}

test("start → ask ×5 → mark → latest shows the score; the 11th answered is quiz_full", async () => {
  const { call, pid } = await api();
  const started = await call("POST", `/v1/projects/${pid}/quizzes`);
  expect(started.status).toBe(201);
  expect(started.body).toMatchObject({ stale: false, items: [], right: 0, marked: 0, score: null });
  const q = started.body.id;
  const ids: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const asked = await call("POST", `/v1/projects/${pid}/quizzes/${q}/questions`, { question: `ใครอนุมัติห้องใหญ่ ข้อ ${i}` });
    expect([asked.status, asked.body.status, asked.body.parts]).toEqual([200, "answered", ["STEP-004"]]);
    ids.push(asked.body.id);
  }
  for (const [i, id] of ids.entries()) {
    const marked = await call("POST", `/v1/projects/${pid}/quizzes/${q}/items/${id}/mark`, { mark: i < 4 ? "right" : "wrong", note: i === 4 ? "ผิด" : undefined });
    expect(marked.status).toBe(200);
  }
  const latest = await call("GET", `/v1/projects/${pid}/quizzes/latest`);
  expect(latest.status).toBe(200);
  expect(latest.body).toMatchObject({ id: q, right: 4, marked: 5, score: 80 });
  expect(latest.body.items[4].questionKey).toMatch(/^Q-\d+$/);

  for (let i = 6; i <= 10; i++) await call("POST", `/v1/projects/${pid}/quizzes/${q}/questions`, { question: `ข้อ ${i}` });
  const full = await call("POST", `/v1/projects/${pid}/quizzes/${q}/questions`, { question: "ข้อ 11" });
  expect([full.status, full.body.error.code]).toEqual([409, "quiz_full"]);
});

test("an older quiz is closed; marks are final; bad bodies 400; unknown ids 404", async () => {
  const { call, pid } = await api();
  const old = (await call("POST", `/v1/projects/${pid}/quizzes`)).body.id;
  const item = (await call("POST", `/v1/projects/${pid}/quizzes/${old}/questions`, { question: "ใครอนุมัติห้องใหญ่" })).body.id;
  await call("POST", `/v1/projects/${pid}/quizzes/${old}/items/${item}/mark`, { mark: "right" });
  const again = await call("POST", `/v1/projects/${pid}/quizzes/${old}/items/${item}/mark`, { mark: "wrong" });
  expect([again.status, again.body.error.code]).toEqual([409, "already_marked"]);

  await call("POST", `/v1/projects/${pid}/quizzes`);
  const closed = await call("POST", `/v1/projects/${pid}/quizzes/${old}/questions`, { question: "อีกข้อ" });
  expect([closed.status, closed.body.error.code]).toEqual([409, "quiz_closed"]);

  const latestId = (await call("GET", `/v1/projects/${pid}/quizzes/latest`)).body.id;
  for (const body of [{}, { question: "   " }, { question: "x".repeat(1_001) }]) {
    expect((await call("POST", `/v1/projects/${pid}/quizzes/${latestId}/questions`, body)).status).toBe(400);
  }
  const it = (await call("POST", `/v1/projects/${pid}/quizzes/${latestId}/questions`, { question: "ข้อใหม่" })).body.id;
  for (const body of [{}, { mark: "maybe" }, { mark: "wrong", note: "x".repeat(2_001) }]) {
    expect((await call("POST", `/v1/projects/${pid}/quizzes/${latestId}/items/${it}/mark`, body)).status).toBe(400);
  }

  const none = "00000000-0000-0000-0000-000000000099";
  expect((await call("POST", `/v1/projects/${none}/quizzes`)).status).toBe(404);
  expect((await call("GET", `/v1/projects/${none}/quizzes/latest`)).status).toBe(404);
  const fresh = (await call("POST", "/v1/projects", { name: "ว่าง" })).body.id;
  expect((await call("GET", `/v1/projects/${fresh}/quizzes/latest`)).status).toBe(404);
  expect((await call("POST", `/v1/projects/${pid}/quizzes/${none}/questions`, { question: "x" })).status).toBe(404);
  expect((await call("POST", `/v1/projects/${pid}/quizzes/${latestId}/items/${none}/mark`, { mark: "right" })).status).toBe(404);
});
