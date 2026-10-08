import { expect, test } from "bun:test";
import { createApp } from "../src/app";
test("GET /health answers ok", async () => {
  const res = await createApp(undefined as any).request("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, service: "blueprint-back" });
});
