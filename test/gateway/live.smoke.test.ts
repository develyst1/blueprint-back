// The one live gateway test (D-003): runs only with BLUEPRINT_GATEWAY_LIVE=1. Invented prompt, no client data.
import { describe, expect, test } from "bun:test";
import { createGateway } from "../../src/gateway/client";

describe.skipIf(process.env.BLUEPRINT_GATEWAY_LIVE !== "1")("LLM Gateway live smoke (skipped unless BLUEPRINT_GATEWAY_LIVE=1)", () => {
  // Count every live call: the decided budget is GET /models + exactly one POST /chat (DECISIONS 2026-10-09).
  const calls: string[] = [];
  const gateway = createGateway({
    retry: false,
    fetch: (url, init) => { calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`); return fetch(url, init); },
  });

  test("lists models, then answers one small chat — exactly two live calls", async () => {
    const list = await gateway.listModels();
    expect(list.ok).toBe(true);
    if (list.ok) expect(Object.keys(list.models)).toContain("openai");
    const r = await gateway.chat({
      model: "tier:small", creativity: 0, messages: [{ role: "user", content: "ตอบคำเดียวว่า สวัสดี" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content.trim().length).toBeGreaterThan(0);
      console.log(`live smoke: answered by ${r.provider}/${r.model}`);
    }
    expect(calls).toEqual(["GET /models", "POST /chat"]);
  }, 200_000);
});
