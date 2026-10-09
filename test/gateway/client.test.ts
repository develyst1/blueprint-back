// The gateway client on recorded answers only (D-003) — no network.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createGateway, type FailReason, type GatewayFetch } from "../../src/gateway/client";

const FIX = new URL("../fixtures/gateway/", import.meta.url).pathname;
const recorded = (name: string) => readFileSync(FIX + name, "utf8");
const BASE = "https://gateway.example.com";
const messages = [{ role: "user" as const, content: "ทักทาย" }];

type Reply = () => Response | Promise<Response>;
// A fake gateway: answers /chat from a queue; counts calls and keeps each request body.
function fake(chatReplies: Reply[]) {
  const bodies: any[] = [];
  let calls = 0;
  const fetch: GatewayFetch = async (url, init) => {
    if (url === `${BASE}/models`) return new Response(recorded("models.json"));
    if (url === `${BASE}/tiers`) throw new Error("GET /tiers must never be called (not an allowed live call)");
    calls++;
    bodies.push(JSON.parse(String(init?.body)));
    const next = chatReplies.shift();
    if (!next) throw new Error("no more recorded replies");
    return next();
  };
  return { fetch, bodies, calls: () => calls };
}
const ok: Reply = () => new Response(recorded("chat-ok.json"));
const http500: Reply = () => new Response(recorded("chat-500.json"), { status: 500 });

test("chat OK; the request carries tier or provider+model, temperature = creativity, max_tokens 4000", async () => {
  const g = fake([ok, ok]);
  const gw = createGateway({ baseUrl: BASE, fetch: g.fetch });
  const a = await gw.chat({ model: "tier:medium", creativity: 0.3, messages });
  expect(a).toEqual({ ok: true, content: "สวัสดีครับ ห้องใหญ่ต้องให้ผู้ดูแลอนุมัติ", provider: "openai", model: "gpt-4.1-mini",
    usage: { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54 } });
  await gw.chat({ model: "openai/gpt-4.1-mini", creativity: 1.2, messages });
  expect(g.bodies[0]).toEqual({ tier: "medium", temperature: 0.3, max_tokens: 4000, messages });
  expect(g.bodies[1]).toEqual({ provider: "openai", model: "gpt-4.1-mini", temperature: 1.2, max_tokens: 4000, messages });
});

test("AC-10 (client): every kind of failure is retried once, then reported with its reason", async () => {
  const cases: [FailReason, Reply][] = [
    ["network", () => { throw new Error("socket hang up"); }],
    ["http_500", http500],
    ["not_json", () => new Response(recorded("chat-not-json.txt"), { status: 200, headers: { "content-type": "text/html" } })],
    ["not_success", () => new Response(recorded("chat-500.json"), { status: 200 })],
    ["empty_content", () => new Response(recorded("chat-empty-content.json"))],
  ];
  for (const [reason, reply] of cases) {
    const g = fake([reply, reply]);
    const r = await createGateway({ baseUrl: BASE, fetch: g.fetch }).chat({ model: "tier:small", creativity: 0, messages });
    expect([reason, r, g.calls()]).toEqual([reason, { ok: false, reason }, 2]);
  }
  const g = fake([http500, ok]);
  const r = await createGateway({ baseUrl: BASE, fetch: g.fetch }).chat({ model: "tier:small", creativity: 0, messages });
  expect([r.ok, g.calls()]).toEqual([true, 2]);
});

test("a gateway that never answers times out", async () => {
  const never: GatewayFetch = () => new Promise(() => {});
  const r = await createGateway({ baseUrl: BASE, fetch: never, timeoutMs: 30 }).chat({ model: "tier:small", creativity: 0, messages });
  expect(r).toEqual({ ok: false, reason: "timeout" });
});

test("listModels: the live model list from GET /models only; tiers are the fixed three; not retried", async () => {
  const g = fake([]);
  const r = await createGateway({ baseUrl: BASE, fetch: g.fetch }).listModels();
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.tiers).toEqual(["small", "medium", "flagship"]);
  expect(r.models.openai).toContain("gpt-4.1-mini");
  expect(Object.keys(r.models)).toEqual(["openai", "gemini", "xai", "deepseek"]);
  let calls = 0;
  const down: GatewayFetch = async () => { calls++; throw new Error("down"); };
  expect(await createGateway({ baseUrl: BASE, fetch: down }).listModels()).toEqual({ ok: false, reason: "network" });
  expect(calls).toBe(1); // GET /models once — no retry, no other call
});

test("retry can be turned off: one failed chat is one call", async () => {
  const g = fake([http500, ok]);
  const r = await createGateway({ baseUrl: BASE, fetch: g.fetch, retry: false }).chat({ model: "tier:small", creativity: 0, messages });
  expect([r, g.calls()]).toEqual([{ ok: false, reason: "http_500" }, 1]);
});

test("a response body over 1 000 000 bytes is too_large, and retried once like any failure", async () => {
  const big = () => new Response("x".repeat(1_000_001));
  const g = fake([big, big]);
  const r = await createGateway({ baseUrl: BASE, fetch: g.fetch }).chat({ model: "tier:small", creativity: 0, messages });
  expect([r, g.calls()]).toEqual([{ ok: false, reason: "too_large" }, 2]);
});
