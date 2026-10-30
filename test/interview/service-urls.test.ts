// REQ-114 / SPEC-111 E13, E13b (TASK-132): an `api` part's `path` may be the full http(s) URL of another service, and the prompt
// says so. Replays the 4 `api` changes the interview refused in TEST-107 round 4 (rebuilt — see the fixture's `_note`) on a stub.
import { expect, test } from "bun:test";
import type { Db } from "../../src/db/client";
import { projects } from "../../src/db/schema";
import { createGateway } from "../../src/gateway/client";
import { kindsBlock, SYSTEM_PROMPT } from "../../src/interview/context";
import { runRound } from "../../src/interview/round";
import { loadSpec } from "../../src/spec/store";
import { testDb } from "../helpers/db";

const TODAY = "2026-10-30";
const MESSAGE = "แสดง 4 บริการ: Blueprint API (http://127.0.0.1:4200/health), Blueprint เว็บ (http://127.0.0.1:3100), CAW API (http://127.0.0.1:4500/health), CAW เว็บ (http://127.0.0.1:3500)";
const REPLAY = await Bun.file(new URL("../fixtures/service-urls-round1.json", import.meta.url)).text();

async function project(): Promise<{ db: Db; pid: string }> {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "Health Board" }).returning();
  return { db, pid: p!.id };
}

test("AC-1 replay (TEST-107 r4, rebuilt): 4 api parts with a full URL → applied, 4 stored with their URLs, nothing refused, 1 call", async () => {
  const { db, pid } = await project();
  const calls = { n: 0 };
  const gateway = createGateway({
    baseUrl: "https://gateway.example.com",
    fetch: async () => {
      calls.n++;
      return new Response(JSON.stringify({ success: true, data: { provider: "openai", model: "stub", content: REPLAY, usage: {}, latency_ms: 1 } }));
    },
  });
  const round = await runRound(db, gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, calls.n]).toEqual(["applied", 1]);
  expect(round.refused).toBeNull();
  const apis = (await loadSpec(db, pid)).parts.filter((p) => p.kind === "api");
  expect(apis.map((p) => [p.title, (p.body as { method: string; path: string }).method, (p.body as { path: string }).path])).toEqual([
    ["Blueprint API Health", "GET", "http://127.0.0.1:4200/health"],
    ["Blueprint เว็บ", "GET", "http://127.0.0.1:3100"],
    ["CAW API Health", "GET", "http://127.0.0.1:4500/health"],
    ["CAW เว็บ", "GET", "http://127.0.0.1:3500"],
  ]);
});

test("E13b: the prompt tells the model that api.path is a path or a full http(s) URL", () => {
  const line = "api.path คือ path ของ API นี้ เริ่มด้วย / (เช่น /rooms) หรือ URL เต็มของบริการอื่น ขึ้นต้น http:// หรือ https:// (เช่น http://127.0.0.1:4200/health)";
  const lines = kindsBlock().split("\n");
  expect(lines).toContain(line);
  expect(SYSTEM_PROMPT).toContain(line);
  // after the link lines, before the ref line
  expect(lines.indexOf(line)).toBeGreaterThan(lines.findIndex((l) => l.startsWith("- covers:")));
  expect(lines.indexOf(line)).toBe(lines.findIndex((l) => l.startsWith("ref คือ")) - 1);
});
