// Writes the OpenAPI document to openapi.json at the repo root: `bun run openapi:emit`.
// The document comes from the real route, so the file and GET /v1/openapi.json cannot drift.
import { createApp } from "../app";
import { createDb } from "../db/client";

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

const app = createApp(await createDb("pglite:memory"));
const res = await app.request("/v1/openapi.json");
if (res.status !== 200) throw new Error(`GET /v1/openapi.json answered ${res.status}`);
const out = new URL("../../openapi.json", import.meta.url);
await Bun.write(out, `${JSON.stringify(sortKeys(await res.json()), null, 2)}\n`);
console.log(`wrote ${out.pathname}`);
