// REQ-110 round 3 / SPEC-105 E7–E10 (TASK-126): the prompt prints each field's type, the server repairs the model's shapes that
// have one reading (and says so), keeps a part when only optional fields are wrong, and keeps why a reply was unreadable.
// Replays the live refusals of TEST-107 round 2 (8 invalid changes, 12 dependents) on a stub — no live call.
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app";
import type { Db } from "../../src/db/client";
import { messages, projects } from "../../src/db/schema";
import { createGateway } from "../../src/gateway/client";
import { CAPS, HEADINGS_MAX, kindsBlock, MODEL_KINDS, optionalField, shapeOf, SYSTEM_PROMPT } from "../../src/interview/context";
import { runRound } from "../../src/interview/round";
import { PART_KINDS, type PartKind } from "../../src/spec/registry";
import { loadSpec } from "../../src/spec/store";
import { BY } from "../helpers/by";
import { testDb } from "../helpers/db";

const TODAY = "2026-10-29";
const MESSAGE = "ทำหน้า Health Board แสดงสถานะบริการ I-Space ให้หน่อย";

function stub(contents: (string | Error)[]) {
  const calls = { n: 0 };
  const gateway = createGateway({
    baseUrl: "https://gateway.example.com",
    fetch: async () => {
      const next = contents[Math.min(calls.n++, contents.length - 1)]!;
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify({ success: true, data: { provider: "openai", model: "stub", content: next, usage: {}, latency_ms: 1 } }));
    },
  });
  return { gateway, calls };
}
const answer = (changes: unknown[], questions: unknown[] = []) => JSON.stringify({ reply: "บันทึกให้แล้วครับ", changes, questions, contradictions: [] });
const item = (change: Record<string, unknown>) => ({ change, saidBy: "user", quote: MESSAGE, sure: true });
const add = (ref: string, kind: string, title: string, body?: unknown) => item({ op: "part.add", ref, kind, title, ...(body === undefined ? {} : { body }) });
const link = (kind: string, from: string, to: string) => item({ op: "link.add", kind, from, to });

async function project(): Promise<{ db: Db; pid: string }> {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "Health Board" }).returning();
  return { db, pid: p!.id };
}
const rowOf = async (db: Db, id: string) => (await db.select().from(messages).where(eq(messages.id, id)))[0]!;

// --- E7: the prompt ------------------------------------------------------------------------------------------

test("E7: the prompt prints the type of every field of every model kind, and the ref pattern", () => {
  const block = kindsBlock();
  for (const kind of MODEL_KINDS) {
    for (const [name, schema] of Object.entries(shapeOf(PART_KINDS[kind as PartKind].body as never))) {
      expect(block).toContain(`${name}${optionalField(schema) ? "?" : ""}: `);
    }
  }
  expect(block).toContain("- decision { rule: string, cases?: string[], neighbouring?: string, open?: string }");
  expect(block).toContain("- screen { fields?: [{ name, label?, type? }], actions?: [{ name, label? }], states?: [{ name, note? }] }");
  expect(block).toContain('method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE"');
  expect(block).toContain("- step { ends?: boolean }");
  expect(block).toContain("$step_view");
  expect(SYSTEM_PROMPT).toContain(block);
  // AC-11: the request stays bounded — the fixed prompt plus the capped blocks (the bound the context tests hold).
  expect(SYSTEM_PROMPT.length + HEADINGS_MAX + Object.values(CAPS).reduce((a, b) => a + b, 0)).toBeLessThan(40_000);
});

// --- E8 / E9: the live replay --------------------------------------------------------------------------------

test("live replay (TEST-107 r2): 5 hyphen refs renamed · system without body · screen lists dropped · decision wrapped + open dropped · links kept", async () => {
  const { db, pid } = await project();
  const g = stub([answer([
    add("$work", "work", "I-Space Health Board", { goal: "หน้าเว็บแสดงสถานะบริการ" }),
    add("$role", "role", "ผู้ใช้งานภายใน", { duty: "เปิดแดชบอร์ด" }),
    add("$monitor", "system", "ตัวตรวจสอบสถานะบริการ"), // no body
    add("$status-data", "data", "สถานะบริการปัจจุบัน", {}),
    add("$dashboard", "screen", "หน้า I-Space Health Board", { fields: "ชื่อบริการ, สถานะ", actions: "เช็คตอนนี้", states: "ปกติ, ล่ม" }),
    add("$availability", "decision", "เกณฑ์สถานะบริการ", { rule: "ตอบ 200 ภายใน 3 วิ = ปกติ", cases: "200 = ปกติ", open: true }),
    add("$step-view", "step", "ดูสถานะบริการ", { ends: false }),
    add("$step-check", "step", "เช็คสถานะบริการ", { ends: true }),
    add("$open-dashboard", "interaction", "เปิดแดชบอร์ด", { text: "เปิดแดชบอร์ด" }),
    add("$manual-check", "interaction", "สั่งเช็คตอนนี้", { text: "สั่งเช็คตอนนี้" }),
    link("has_step", "$work", "$step-view"), link("has_step", "$work", "$step-check"),
    link("has_interaction", "$step-view", "$open-dashboard"), link("has_interaction", "$step-check", "$manual-check"),
    link("from", "$open-dashboard", "$role"), link("to", "$open-dashboard", "$dashboard"),
    link("from", "$manual-check", "$role"), link("to", "$manual-check", "$monitor"),
    link("shows", "$dashboard", "$status-data"), link("covers", "$availability", "$monitor"),
  ], [{ text: "ตรวจ URL จากฝั่งเซิร์ฟเวอร์ใช่ไหม", proposedAnswer: "ใช่", cases: [], about: "$availability" }])]);

  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, round.refused, g.calls.n]).toEqual(["applied", null, 1]); // nothing refused, no correction call, the reply is shown
  expect(round.reply).toBe("บันทึกให้แล้วครับ");
  const spec = await loadSpec(db, pid);
  const kinds = spec.parts.map((p) => p.kind).sort();
  expect(kinds).toEqual(["data", "decision", "interaction", "interaction", "question", "role", "screen", "step", "step", "system", "work"]);
  const body = (kind: string) => spec.parts.find((p) => p.kind === kind)!.body as Record<string, unknown>;
  expect(body("system")).toEqual({});
  expect(body("decision")).toMatchObject({ rule: "ตอบ 200 ภายใน 3 วิ = ปกติ", cases: ["200 = ปกติ"] });
  expect(body("decision")).not.toHaveProperty("open");
  expect(Array.isArray(body("screen").fields) && (body("screen").fields as unknown[]).length === 0).toBe(true); // the malformed lists were dropped
  expect(spec.links).toHaveLength(10 + 1); // the 10 links the model drew, and the question's `about`
  expect(spec.links.some((l) => l.kind === "covers")).toBe(true);

  const adjusted = round.adjusted!;
  const of = (what: string) => adjusted.filter((a) => (a as { what?: string }).what === what);
  expect(of("ref_renamed").map((a) => [(a as any).from, (a as any).to])).toEqual([
    ["$status-data", "$status_data"], ["$step-view", "$step_view"], ["$step-check", "$step_check"],
    ["$open-dashboard", "$open_dashboard"], ["$manual-check", "$manual_check"],
  ]);
  expect(of("body_defaulted")).toEqual([{ item: "changes[2]", what: "body_defaulted", title: "ตัวตรวจสอบสถานะบริการ", key: null, ref: "$monitor" }]);
  expect(of("wrapped_in_list")).toEqual([{ item: "changes[5]", what: "wrapped_in_list", title: "เกณฑ์สถานะบริการ", key: null, ref: "$availability", field: "cases" }]);
  expect(of("ref_renamed")[0]).toMatchObject({ item: "changes[3]", title: "สถานะบริการปัจจุบัน", key: null, ref: "$status_data" }); // the ref as stored
  expect(of("field_dropped").map((a) => [(a as any).item, (a as any).field]).sort()).toEqual([
    ["changes[4]", "actions"], ["changes[4]", "fields"], ["changes[4]", "states"], ["changes[5]", "open"],
  ]);
  expect((await rowOf(db, round.messageIds[1]!)).roundAdjusted).toEqual(adjusted);
});

test("a ref collision (`$a-b` and `$a_b` in one answer) → no rename: the hyphen one is refused as today, its link with it", async () => {
  const { db, pid } = await project();
  const g = stub([answer([
    add("$a-b", "role", "หนึ่ง", {}), add("$a_b", "role", "สอง", {}), add("$w", "work", "งาน", {}),
    link("has_step", "$w", "$a-b"),
  ])]);
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect(round.status).toBe("applied");
  expect(round.adjusted).toBeNull(); // nothing was renamed
  expect(round.refused!.map((r) => [(r as any).item, (r as any).reason])).toEqual([["changes[0]", "invalid_change"], ["changes[3]", "depends_on_refused"]]);
  expect((await loadSpec(db, pid)).parts.map((p) => p.title).sort()).toEqual(["งาน", "สอง"]);
});

test("a required field wrong (decision without `rule`) → still refused, not repaired", async () => {
  const { db, pid } = await project();
  const g = stub([answer([add("$d", "decision", "เกณฑ์", { cases: ["ก"] }), add("$r", "role", "ฝ่ายขาย", {})])]);
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect(round.refused!.map((r) => [(r as any).item, (r as any).kind, (r as any).reason])).toEqual([["changes[0]", "decision", "invalid_change"]]);
  expect(round.adjusted).toBeNull();
  expect((await loadSpec(db, pid)).parts.map((p) => p.title)).toEqual(["ฝ่ายขาย"]);
});

test("an unknown body field is not an optional field: refused, not dropped", async () => {
  const { db, pid } = await project();
  const g = stub([answer([add("$r", "role", "ฝ่ายขาย", { duty: "ขาย", bogus: 1 })])]);
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, (round.refused![0] as any).reason]).toEqual(["changes_rejected", "invalid_change"]);
});

test("an adjustment on an item that was dropped afterwards leaves no trace in the record", async () => {
  const { db, pid } = await project();
  // `$bad-x` is renamed, but its step then fails the store (an unknown field): it is refused, so its rename is not recorded
  const g = stub([answer([add("$bad-x", "step", "ขั้น", { ends: true, bogus: 1 }), add("$r", "role", "ฝ่ายขาย", {})])]);
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect(round.status).toBe("applied");
  expect(round.adjusted).toBeNull();
});

// --- E10: why a reply was unreadable -------------------------------------------------------------------------

function sequence(first: string, then: (n: number) => Response) {
  const calls = { n: 0 };
  const gateway = createGateway({
    baseUrl: "https://gateway.example.com",
    fetch: async () => {
      calls.n++;
      return calls.n === 1
        ? new Response(JSON.stringify({ success: true, data: { provider: "openai", model: "stub", content: first, usage: {}, latency_ms: 1 } }))
        : then(calls.n);
    },
  });
  return { gateway, calls };
}

test("E10: unreadable first reply, then the re-ask fails with http_503 → reason protocol, note `then http_503`, roundRaw = the first 4000 chars", async () => {
  const { db, pid } = await project();
  const unreadable = "ไม่ใช่ JSON " + "x".repeat(5000) + "\u0000";
  const g = sequence(unreadable, () => new Response("down", { status: 503 }));
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, round.reason, round.note]).toEqual(["bot_could_not_answer", "protocol", "then http_503"]);
  const bot = await rowOf(db, round.messageIds[1]!);
  expect([bot.roundReason, bot.roundNote]).toEqual(["protocol", "then http_503"]);
  expect(bot.roundRaw).toBe(unreadable.replaceAll("\u0000", "").slice(0, 4000));
  expect(bot.roundRaw!.length).toBe(4000);
});

test("E10: unreadable twice → reason protocol, no note, the first reply kept", async () => {
  const { db, pid } = await project();
  const g = stub(["first: not json", "second: not json either"]);
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, round.reason, round.note]).toEqual(["bot_could_not_answer", "protocol", null]);
  expect((await rowOf(db, round.messageIds[1]!)).roundRaw).toBe("first: not json");
});

test("GET …/messages returns roundAdjusted and roundRaw, null on plain rows", async () => {
  const db = await testDb();
  const app = createApp(db);
  const made = await app.request("/v1/projects", { method: "POST", headers: { ...BY, "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
  const pid = ((await made.json()) as any).id as string;
  await runRound(db, stub([answer([add("$a-b", "role", "ฝ่ายขาย", {})])]).gateway, pid, { message: MESSAGE }, { today: TODAY });
  await runRound(db, stub(["oops", "oops again"]).gateway, pid, { message: MESSAGE }, { today: TODAY });
  const list = (await (await app.request(`/v1/projects/${pid}/messages`)).json()) as any[];
  const bots = list.filter((m) => m.role === "bot");
  expect(bots[0].roundAdjusted).toEqual([{ item: "changes[0]", what: "ref_renamed", title: "ฝ่ายขาย", key: null, ref: "$a_b", from: "$a-b", to: "$a_b" }]);
  expect(bots[0].roundRaw).toBeNull();
  expect([bots[1].roundAdjusted, bots[1].roundRaw, bots[1].roundReason]).toEqual([null, "oops", "protocol"]);
  expect(list.filter((m) => m.role === "user").every((m) => m.roundAdjusted === null && m.roundRaw === null)).toBe(true);
});
