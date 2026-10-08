import { expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { PartKind } from "../../src/spec/registry";
import type { Change } from "../../src/spec/types";
import { testDb } from "../helpers/db";

// AC-14: an invented project (no client data) of 52 parts and 168 links, every link allowed by the registry.
const origin = { stamp: "operator", date: "2026-10-08" } as const;

function inventedProject(): Change[] {
  const parts: Change[] = [];
  const links: Change[] = [];
  const add = (ref: string, kind: PartKind, body: Record<string, unknown> = {}) =>
    parts.push({ op: "part.add", ref, kind, title: `${kind} ${ref}`, body, origin });
  const link = (kind: Extract<Change, { op: "link.add" }>["kind"], from: string, to: string, label?: string) =>
    links.push({ op: "link.add", kind, from, to, origin, ...(label ? { label } : {}) });
  const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  add("$w", "work");
  range(10).forEach((i) => add(`$s${i}`, "step", { ends: i === 10 }));
  range(20).forEach((i) => add(`$i${i}`, "interaction", { text: `ข้อความ ${i}` }));
  range(3).forEach((i) => add(`$r${i}`, "role"));
  range(6).forEach((i) => add(`$scr${i}`, "screen"));
  range(6).forEach((i) => add(`$api${i}`, "api", { method: "GET", path: `/things/${i}` }));
  range(2).forEach((i) => add(`$sys${i}`, "system"));
  range(2).forEach((i) => add(`$d${i}`, "data"));
  add("$dec", "decision", { rule: "กฎตัวอย่าง" });
  add("$q", "question", { text: "คำถามตัวอย่าง" });

  range(10).forEach((i) => link("has_step", "$w", `$s${i}`));                               // 10
  range(9).forEach((i) => link("next", `$s${i}`, `$s${i + 1}`));                           // 9
  range(20).forEach((i) => link("has_interaction", `$s${Math.ceil(i / 2)}`, `$i${i}`));    // 20
  range(20).forEach((i) => link("from", `$i${i}`, i % 2 ? `$r${(i % 3) + 1}` : `$scr${(i % 6) + 1}`)); // 20
  range(20).forEach((i) => link("to", `$i${i}`, i % 2 ? `$scr${(i % 6) + 1}` : `$api${(i % 6) + 1}`)); // 20
  range(20).forEach((i) => link("carries", `$i${i}`, `$d${(i % 2) + 1}`));                 // 20
  range(6).forEach((a) => range(2).forEach((d) => link("reads", `$api${a}`, `$d${d}`)));    // 12
  range(6).forEach((a) => range(2).forEach((d) => link("writes", `$api${a}`, `$d${d}`)));   // 12
  range(6).forEach((s) => range(2).forEach((d) => link("shows", `$scr${s}`, `$d${d}`)));    // 12
  range(10).forEach((i) => link("covers", "$dec", `$s${i}`));                              // 10
  range(20).forEach((i) => link("covers", "$dec", `$i${i}`));                              // 20
  range(2).forEach((i) => link("covers", "$dec", `$sys${i}`));                             // 2
  link("about", "$q", "$s1");                                                              // 1
  return [...parts, ...links];
}

test("AC-14: 'what is stuck' answers in under a second for 52 parts and 168 links", async () => {
  const app = createApp(await testDb());
  const json = async (res: Response) => (await res.json()) as any;
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  const { id } = await json(await post("/v1/projects", { name: "โปรเจกต์ทดสอบขนาด" }));
  const stored = await post(`/v1/projects/${id}/change-sets`, { cause: { kind: "operator" }, changes: inventedProject() });
  expect(stored.status).toBe(201);
  const spec = await json(await app.request(`/v1/projects/${id}`));
  expect(spec.parts).toHaveLength(52);
  expect(spec.links).toHaveLength(168);

  const started = performance.now();
  const res = await app.request(`/v1/projects/${id}/stuck`);
  const ms = performance.now() - started;
  expect(res.status).toBe(200);
  await res.json();
  console.log(`AC-14: GET /stuck on 52 parts / 168 links took ${ms.toFixed(1)} ms`);
  expect(ms).toBeLessThan(1000);
});
