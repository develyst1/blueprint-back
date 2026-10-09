// GET /v1/models and PATCH /v1/projects/{id} on recorded gateway answers — no network.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createApp } from "../../src/app";
import { createGateway, type GatewayFetch } from "../../src/gateway/client";
import { meetingRoom } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";

const FIX = new URL("../fixtures/gateway/", import.meta.url).pathname;
const BASE = "https://gateway.example.com";

function gatewayCounting(up = true) {
  let calls = 0;
  const fetch: GatewayFetch = async (url) => {
    calls++;
    if (!up) throw new Error("down");
    if (url === `${BASE}/models`) return new Response(readFileSync(FIX + "models.json", "utf8"));
    if (url === `${BASE}/tiers`) throw new Error("GET /tiers must never be called");
    throw new Error(`unexpected ${url}`);
  };
  return { gateway: createGateway({ baseUrl: BASE, fetch }), calls: () => calls };
}

async function api(up = true) {
  const g = gatewayCounting(up);
  const app = createApp(await testDb(), { gateway: g.gateway });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const pid = (await call("POST", "/v1/projects", { name: "x" })).body.id as string;
  return { call, pid, calls: g.calls };
}

test("GET /v1/models reads the gateway live on every call; down → 503 gateway_unavailable", async () => {
  const { call, calls } = await api();
  const r = await call("GET", "/v1/models");
  expect(r.status).toBe(200);
  expect(r.body.tiers).toEqual(["small", "medium", "flagship"]);
  expect(r.body.models.deepseek).toEqual(["deepseek-reasoner", "deepseek-chat", "deepseek-v4-flash"]);
  const before = calls();
  await call("GET", "/v1/models");
  expect(calls()).toBeGreaterThan(before);
  const down = await (await api(false)).call("GET", "/v1/models");
  expect([down.status, down.body.error.code, down.body.error.details.reason]).toEqual([503, "gateway_unavailable", "network"]);
});

test("PATCH model and creativity: tiers need no gateway call; provider models must be in the live list", async () => {
  const { call, pid, calls } = await api();
  const before = calls();
  const tier = await call("PATCH", `/v1/projects/${pid}`, { model: "tier:flagship" });
  expect([tier.status, tier.body.model]).toEqual([200, "tier:flagship"]);
  expect(calls()).toBe(before);
  const listed = await call("PATCH", `/v1/projects/${pid}`, { model: "openai/gpt-4.1-mini", creativity: 1.5 });
  expect([listed.status, listed.body.model, listed.body.creativity]).toEqual([200, "openai/gpt-4.1-mini", 1.5]);
  for (const bad of [{ model: "openai/not-a-model" }, { model: "tier:huge" }, { creativity: 2.5 }, { creativity: -0.1 }, {}]) {
    const r = await call("PATCH", `/v1/projects/${pid}`, bad);
    expect([JSON.stringify(bad), r.status, r.body.error.code]).toEqual([JSON.stringify(bad), 400, "validation"]);
  }
  expect((await call("PATCH", "/v1/projects/00000000-0000-0000-0000-000000000099", { creativity: 1 })).status).toBe(404);
  const down = await api(false);
  const r = await down.call("PATCH", `/v1/projects/${down.pid}`, { model: "openai/gpt-4.1-mini" });
  expect([r.status, r.body.error.code]).toEqual([503, "gateway_unavailable"]);
  expect((await down.call("PATCH", `/v1/projects/${down.pid}`, { model: "tier:small" })).status).toBe(200);
});

test("AC-9: changing the model keeps the spec and what is stuck exactly as they were", async () => {
  const { call, pid } = await api();
  await call("POST", `/v1/projects/${pid}/change-sets`, { cause: { kind: "operator" }, changes: meetingRoom });
  const specBefore = (await call("GET", `/v1/projects/${pid}`)).body;
  const stuckBefore = (await call("GET", `/v1/projects/${pid}/stuck`)).body;
  expect((await call("PATCH", `/v1/projects/${pid}`, { model: "openai/gpt-4.1-mini" })).status).toBe(200);
  const specAfter = (await call("GET", `/v1/projects/${pid}`)).body;
  expect(specAfter.parts).toEqual(specBefore.parts);
  expect(specAfter.links).toEqual(specBefore.links);
  expect((await call("GET", `/v1/projects/${pid}/stuck`)).body).toEqual(stuckBefore);
  expect([specBefore.project.model, specAfter.project.model]).toEqual(["tier:medium", "openai/gpt-4.1-mini"]);
});
