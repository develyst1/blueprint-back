// POST …/rounds and GET …/messages over HTTP, on recorded gateway answers only — no live call.
import { expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { messages } from "../../src/db/schema";
import { createGateway, type GatewayFetch } from "../../src/gateway/client";
import { meetingRoom } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";

const BASE = "https://gateway.example.com";
const answer = { reply: "รับทราบครับ", changes: [], questions: [], contradictions: [] };

async function api() {
  let chats = 0;
  const fetch: GatewayFetch = async (url) => {
    if (!url.endsWith("/chat")) throw new Error(`unexpected ${url}`);
    chats++;
    return new Response(JSON.stringify({ success: true, data: { provider: "openai", model: "gpt-4.1-mini",
      content: JSON.stringify(answer), usage: {}, latency_ms: 5 } }));
  };
  const db = await testDb();
  const app = createApp(db, { gateway: createGateway({ baseUrl: BASE, fetch }) });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const pid = (await call("POST", "/v1/projects", { name: "จองห้องประชุม" })).body.id as string;
  await call("POST", `/v1/projects/${pid}/change-sets`, { cause: { kind: "operator" }, changes: meetingRoom });
  return { db, call, pid, chats: () => chats };
}

test("POST …/rounds → 200 Round; the user and bot messages are stored", async () => {
  const { call, pid } = await api();
  const r = await call("POST", `/v1/projects/${pid}/rounds`, { message: "สวัสดีครับ" });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ status: "no_changes", reply: "รับทราบครับ", changeSetId: null, questions: [], contradictions: [], failedSources: [] });
  expect(r.body.messageIds).toHaveLength(2);
  const list = (await call("GET", `/v1/projects/${pid}/messages`)).body;
  expect(list.map((m: any) => [m.role, m.content, m.roundStatus])).toEqual([
    ["user", "สวัสดีครับ", null], ["bot", "รับทราบครับ", "no_changes"],
  ]);
  expect(list[1]).toMatchObject({ model: "openai/gpt-4.1-mini", creativity: 0.5, changeSetId: null });
});

test("rounds input: nothing given, too long, or a key that is not an open question with an answer → 400, no call", async () => {
  const { call, pid, chats } = await api();
  for (const body of [{}, { message: "x".repeat(20_001) }, { accept: Array.from({ length: 21 }, (_, i) => `Q-${100 + i}`) },
    { accept: ["STEP-001"] }, { accept: ["Q-404"] }, { accept: ["Q-001", "Q-001"] }, { message: "a\u0000b" }]) {
    const r = await call("POST", `/v1/projects/${pid}/rounds`, body);
    expect([JSON.stringify(body).slice(0, 40), r.status, r.body.error.code]).toEqual([JSON.stringify(body).slice(0, 40), 400, "validation"]);
  }
  expect(chats()).toBe(0);
  expect((await call("GET", `/v1/projects/${pid}/messages`)).body).toEqual([]);
  expect((await call("POST", "/v1/projects/00000000-0000-0000-0000-000000000099/rounds", { message: "x" })).status).toBe(404);
});

test("GET …/messages?limit=3 → the 3 newest, oldest first; limit 0 or 201 → 400; unknown project → 404", async () => {
  const { db, call, pid } = await api();
  for (let i = 1; i <= 5; i++) {
    await db.insert(messages).values({ projectId: pid, role: "user", content: `m${i}`, model: "tier:medium", creativity: 0.5,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) });
  }
  const three = await call("GET", `/v1/projects/${pid}/messages?limit=3`);
  expect([three.status, three.body.map((m: any) => m.content)]).toEqual([200, ["m3", "m4", "m5"]]);
  for (const limit of ["0", "201", "x"]) {
    expect((await call("GET", `/v1/projects/${pid}/messages?limit=${limit}`)).status).toBe(400);
  }
  expect((await call("GET", "/v1/projects/00000000-0000-0000-0000-000000000099/messages")).status).toBe(404);
});

test("A-033 over HTTP: park alone → 200 applied, reply null, no gateway call; bad answers/park bodies → 400", async () => {
  const { call, pid, chats } = await api();
  const q = await call("POST", `/v1/projects/${pid}/change-sets`, { cause: { kind: "operator" }, changes: [{ op: "part.add", ref: "$q", kind: "question",
    title: "ห้องพอดี 10 คนต้องอนุมัติไหม", body: { text: "ห้องพอดี 10 คนต้องอนุมัติไหม", status: "open" }, origin: { stamp: "operator", date: "2026-10-09" } }] });
  const key = q.body.keys.$q as string;
  const parked = await call("POST", `/v1/projects/${pid}/rounds`, { park: [{ key, reason: "ยังไม่ต้อง" }] });
  expect([parked.status, parked.body.status, parked.body.reply, chats()]).toEqual([200, "applied", null, 0]);
  for (const body of [{ answers: [{ key }] }, { answers: [{ key: "Q-001", text: "" }] }, { park: [{ reason: "x" }] }, { answers: "x" }, {}]) {
    expect((await call("POST", `/v1/projects/${pid}/rounds`, body)).status).toBe(400);
  }
  expect(chats()).toBe(0);
});

test("A-037 over HTTP: retry with another field → 400; nothing to retry → 409 nothing_to_retry", async () => {
  const { call, pid, chats } = await api();
  expect((await call("POST", `/v1/projects/${pid}/rounds`, { retry: true, message: "x" })).status).toBe(400);
  const r = await call("POST", `/v1/projects/${pid}/rounds`, { retry: true });
  expect([r.status, r.body.error.code]).toEqual([409, "nothing_to_retry"]);
  expect(chats()).toBe(0);
});
