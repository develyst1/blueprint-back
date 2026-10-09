// SPEC-A-003 § "Provenance guard" (TASK-A-020 REWORK): the server only downgrades a stamp, never trusts the model.
// Recorded gateway answers only — no live call.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app";
import type { Db } from "../../src/db/client";
import { projects } from "../../src/db/schema";
import { createGateway, type GatewayFetch } from "../../src/gateway/client";
import { runRound } from "../../src/interview/round";
import { addFile } from "../../src/sources/service";
import { applyChangeSet, loadSpec } from "../../src/spec/store";
import { computeStuck } from "../../src/spec/stuck";
import type { Change } from "../../src/spec/types";
import { meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";

const SRC = new URL("../fixtures/sources/", import.meta.url).pathname;
const BASE = "https://gateway.example.com";
const TODAY = "2026-10-09";
const dirs: string[] = [];
let logged: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => { logged = []; spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); }); });
afterEach(() => { spy.mockRestore(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const said = (content: unknown) => () => new Response(JSON.stringify({ success: true,
  data: { provider: "openai", model: "gpt-4.1-mini", content: JSON.stringify(content), usage: {}, latency_ms: 5 } }));
function fake(answers: (() => Response)[]) {
  let calls = 0;
  const fetch: GatewayFetch = async () => { calls++; const a = answers.shift(); if (!a) throw new Error("no more answers"); return a(); };
  return { gateway: createGateway({ baseUrl: BASE, fetch }), calls: () => calls };
}
async function project() {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: meetingRoom });
  const dir = mkdtempSync(join(tmpdir(), "blueprint-guard-"));
  dirs.push(dir);
  return { db, pid: p!.id, dir };
}
const role = (title: string, extra: Record<string, unknown>) =>
  ({ change: { op: "part.add", ref: "$r", kind: "role", title, body: {} }, sure: true, ...extra });
const answer = (changes: unknown[], more: Record<string, unknown> = {}) =>
  ({ reply: "รับทราบ", changes, questions: [], contradictions: [], ...more });
const stampOf = async (db: Db, pid: string, title: string) => (await loadSpec(db, pid)).parts.find((p) => p.title === title)?.origin;

test("R1: saidBy user is operator only with a quote found in this round's message", async () => {
  const cases: [string, { message?: string; accept?: string[] }, Record<string, unknown>, string][] = [
    ["quote in message", { message: "เพิ่ม  ฝ่ายอาคาร เข้ามาด้วย" }, { saidBy: "user", quote: "เพิ่ม ฝ่ายอาคาร" }, "operator"],
    ["no quote", { message: "เพิ่มฝ่ายอาคาร" }, { saidBy: "user" }, "team-proposed"],
    ["quote not in message", { message: "เพิ่มฝ่ายอาคาร" }, { saidBy: "user", quote: "ผู้ใช้สั่งให้เพิ่ม" }, "team-proposed"],
    ["accept-only round", { accept: ["Q-001"] }, { saidBy: "user", quote: "" }, "team-proposed"],
  ];
  for (const [label, input, saidBy, stamp] of cases) {
    const { db, pid } = await project();
    const { gateway } = fake([said(answer([role("ฝ่ายอาคาร", saidBy)]))]);
    expect((await runRound(db, gateway, pid, input, { today: TODAY })).status).toBe("applied");
    expect([label, (await stampOf(db, pid, "ฝ่ายอาคาร"))?.stamp]).toEqual([label, stamp]);
  }
});

test("R2: a source's stamp only with a found quote; customer-validated is capped at customer-asked; sourceId kept", async () => {
  const quote = "ผู้ดูแลห้องต้องตอบภายใน 24 ชั่วโมง";
  const cases: [string, Record<string, unknown>, string, Record<string, unknown>][] = [
    ["found, customer-asked source", { stamp: "customer-asked", date: "2026-10-01" }, quote, { stamp: "customer-asked" }],
    ["found, operator source", { stamp: "operator", date: "2026-10-01" }, quote, { stamp: "operator" }],
    ["found, customer-validated source", { stamp: "customer-validated", date: "2026-10-01", channel: "LINE" }, quote, { stamp: "customer-asked" }],
    ["quote not in the source", { stamp: "customer-validated", date: "2026-10-01", channel: "LINE" }, "ไม่มีในเอกสาร", { stamp: "team-proposed" }],
  ];
  for (const [label, origin, q, expected] of cases) {
    const { db, pid, dir } = await project();
    const src = await addFile(db, dir, pid, { name: "notes.txt", bytes: readFileSync(SRC + "notes.txt"), origin });
    const { gateway } = fake([said(answer([role("ฝ่ายอาคาร", { saidBy: { source: src.id }, quote: q })]))]);
    await runRound(db, gateway, pid, { message: "อ่านเอกสารแล้วเพิ่มให้" }, { today: TODAY });
    const got = await stampOf(db, pid, "ฝ่ายอาคาร");
    expect([label, got]).toEqual([label, expect.objectContaining({ ...expected, date: TODAY, sourceId: src.id })]);
  }
});

test("R3: question/contradiction edits and unquoted removes from the model are refused (one correction, then rejected)", async () => {
  const bad: [string, unknown][] = [
    ["part.add question", { op: "part.add", ref: "$q", kind: "question", title: "q", body: { text: "q", proposedAnswer: "a" } }],
    ["part.update question → answered", { op: "part.update", key: "Q-001", body: { text: "x", proposedAnswer: "y", status: "answered", answer: "y" } }],
    ["part.add contradiction", { op: "part.add", ref: "$c", kind: "contradiction", title: "c", body: { note: "c" } }],
    ["part.remove without a verified quote", { op: "part.remove", key: "ROLE-002" }],
  ];
  for (const [label, change] of bad) {
    const { db, pid } = await project();
    const before = await loadSpec(db, pid);
    const reply = answer([{ change, saidBy: "user", sure: true }]);
    const g = fake([said(reply), said(reply)]);
    const r = await runRound(db, g.gateway, pid, { message: "แก้ให้หน่อย" }, { today: TODAY });
    expect([label, r.status, g.calls()]).toEqual([label, "changes_rejected", 2]);
    expect(await loadSpec(db, pid)).toEqual(before);
  }
});

test("R4: changing an operator-stamped part needs a verified user quote", async () => {
  const update = { op: "part.update", key: "STEP-001", title: "ค้นหาห้องที่ว่าง" };
  const { db, pid } = await project();
  const noQuote = answer([{ change: update, saidBy: "inferred", sure: true }]);
  const g = fake([said(noQuote), said(noQuote)]);
  expect((await runRound(db, g.gateway, pid, { message: "ปรับชื่อให้ดีขึ้น" }, { today: TODAY })).status).toBe("changes_rejected");
  const withQuote = answer([{ change: update, saidBy: "user", quote: "เปลี่ยนชื่อขั้นแรก", sure: true }]);
  const g2 = fake([said(withQuote)]);
  expect((await runRound(db, g2.gateway, pid, { message: "เปลี่ยนชื่อขั้นแรกเป็น ค้นหาห้องที่ว่าง" }, { today: TODAY })).status).toBe("applied");
  expect((await loadSpec(db, pid)).parts.find((p) => p.key === "STEP-001")!.title).toBe("ค้นหาห้องที่ว่าง");
  // A remove with a verified quote is allowed (and takes the part's links with it).
  const remove = answer([{ change: { op: "part.remove", key: "ROLE-002" }, saidBy: "user", quote: "ลบผู้ดูแลห้องออก", sure: true }]);
  const g3 = fake([said(remove)]);
  expect((await runRound(db, g3.gateway, pid, { message: "ลบผู้ดูแลห้องออก" }, { today: TODAY })).status).toBe("applied");
});

test("R5: at most 5 contradictions are stored; a gateway body over 1 000 000 bytes is too_large → bot_could_not_answer", async () => {
  const { db, pid } = await project();
  const seven = Array.from({ length: 7 }, (_, i) => ({ note: `ขัดกันข้อ ${i + 1}`, between: ["DEC-001", "STEP-003"] }));
  const g = fake([said(answer([], { contradictions: seven }))]);
  const r = await runRound(db, g.gateway, pid, { message: "เทียบให้หน่อย" }, { today: TODAY });
  expect(r.contradictions).toHaveLength(5);
  expect(computeStuck(await loadSpec(db, pid)).filter((i) => i.kind === "contradiction")).toHaveLength(5);

  const big = () => new Response("x".repeat(1_000_001));
  const g2 = fake([big, big]);
  const r2 = await runRound(db, g2.gateway, pid, { message: "สวัสดี" }, { today: TODAY });
  expect([r2.status, g2.calls()]).toEqual(["bot_could_not_answer", 2]);
  expect(logged).toContain("[round] bot_could_not_answer reason=too_large");
});

test("R6: a forced 500 logs the error's name and code only — no params, no text", async () => {
  const db = await testDb();
  const g = fake([]);
  const app = createApp(db, { gateway: g.gateway });
  const pid = (await (await app.request("/v1/projects", { method: "POST", body: JSON.stringify({ name: "x" }),
    headers: { "content-type": "application/json" } })).json() as any).id;
  await db.update(projects).set({ model: "not-a-model-id" }).where(eq(projects.id, pid)); // the client throws on it
  const res = await app.request(`/v1/projects/${pid}/rounds`, { method: "POST",
    body: JSON.stringify({ message: "ข้อความลับของผู้ใช้" }), headers: { "content-type": "application/json" } });
  expect(res.status).toBe(500);
  expect(logged.length).toBeGreaterThan(0);
  for (const line of logged) {
    expect(line).not.toContain("not-a-model-id");
    expect(line).not.toContain("ข้อความลับของผู้ใช้");
    expect(line).not.toContain("params");
  }
  expect(logged).toContain("[http] 500 Error");
});

test("A-023 step 2: a quote counts only from 10 characters (normalised) — user and source alike", async () => {
  const userCases: [string, string][] = [["abcdefghi", "team-proposed"], ["abcdefghij", "operator"]];
  for (const [quote, stamp] of userCases) {
    const { db, pid } = await project();
    const { gateway } = fake([said(answer([role("ฝ่ายอาคาร", { saidBy: "user", quote })]))]);
    await runRound(db, gateway, pid, { message: "please add  abcdefghij  now" }, { today: TODAY });
    const got: unknown = (await stampOf(db, pid, "ฝ่ายอาคาร"))?.stamp;
    expect([quote.length, got]).toEqual([quote.length, stamp]);
  }
  const line = "ผู้ดูแลห้องต้องตอบภายใน";
  const sourceCases: [string, string][] = [[line.slice(0, 9), "team-proposed"], [line.slice(0, 10), "customer-asked"]];
  for (const [quote, stamp] of sourceCases) {
    const { db, pid, dir } = await project();
    const src = await addFile(db, dir, pid, { name: "notes.txt", bytes: readFileSync(SRC + "notes.txt"),
      origin: { stamp: "customer-asked", date: "2026-10-01" } });
    const { gateway } = fake([said(answer([role("ฝ่ายอาคาร", { saidBy: { source: src.id }, quote })]))]);
    await runRound(db, gateway, pid, { message: "อ่านเอกสาร" }, { today: TODAY });
    const got: unknown = (await stampOf(db, pid, "ฝ่ายอาคาร"))?.stamp;
    expect([quote.length, got]).toEqual([quote.length, stamp]);
  }
});
