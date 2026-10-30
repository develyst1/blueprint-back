// REQ-110 round 2 / SPEC-105 E5–E6 (TASK-123): a round stores the model's valid items, drops only the refused ones (with the
// items that name their `$ref`), and records each refusal. Stub gateways only — no live call.
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app";
import type { Db } from "../../src/db/client";
import { messages, projects } from "../../src/db/schema";
import { createGateway } from "../../src/gateway/client";
import { runRound } from "../../src/interview/round";
import { applyChangeSet, loadSpec } from "../../src/spec/store";
import { meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { BY } from "../helpers/by";
import { testDb } from "../helpers/db";

const TODAY = "2026-10-29";
const MESSAGE = "ผมอยากได้ข้อมูลเพิ่ม ช่วยเพิ่มให้หน่อย";

// POST /chat answers from a queue (the last answer repeats; an Error is a network failure); `calls.n` counts requests.
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
type Extra = { questions?: unknown[]; contradictions?: unknown[] };
const answer = (changes: unknown[], extra: Extra = {}, text = "บันทึกให้แล้วครับ") =>
  JSON.stringify({ reply: text, changes, questions: extra.questions ?? [], contradictions: extra.contradictions ?? [] });
const item = (change: Record<string, unknown>) => ({ change, saidBy: "user", quote: MESSAGE, sure: true });
const role = (ref: string, title: string, body: Record<string, unknown> = {}) => item({ op: "part.add", ref, kind: "role", title, body });
const feature = (ref: string, title = "ฟีเจอร์") => item({ op: "part.add", ref, kind: "feature", title, body: {} });

async function project(): Promise<{ db: Db; pid: string }> {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้อง" }).returning();
  await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: meetingRoom });
  return { db, pid: p!.id };
}
const rowOf = async (db: Db, id: string) => (await db.select().from(messages).where(eq(messages.id, id)))[0]!;
const titles = async (db: Db, pid: string) => (await loadSpec(db, pid)).parts.map((p) => p.title);

test("AC-6: 5 changes, 1 the store refuses (an unknown body field) → 4 stored, applied, the 1 named with the store's message", async () => {
  const { db, pid } = await project();
  const before = (await loadSpec(db, pid)).parts.length;
  const g = stub([answer([
    role("$a", "ฝ่ายขาย"), role("$b", "ฝ่ายบัญชี"), role("$c", "ฝ่ายจัดซื้อ", { bogus: 1 }), role("$d", "ฝ่ายคลัง"), role("$e", "ฝ่ายบุคคล"),
  ])]);
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, round.reply, typeof round.changeSetId, g.calls.n]).toEqual(["applied", null, "string", 1]); // no extra gateway call
  expect((await loadSpec(db, pid)).parts.length).toBe(before + 4);
  expect(await titles(db, pid)).not.toContain("ฝ่ายจัดซื้อ");
  expect(round.refused).toEqual([{
    item: "changes[2]", op: "part.add", kind: "role", ref: "$c", key: null, title: "ฝ่ายจัดซื้อ", reason: "invalid_change", detail: expect.any(String),
  }]);
  const detail = (round.refused![0] as { detail: string }).detail;
  expect(detail.length > 0 && detail.length <= 200).toBe(true);
  const bot = await rowOf(db, round.messageIds[1]!);
  expect([bot.roundStatus, bot.content, bot.roundReason]).toEqual(["applied", "", null]); // E5c: the model's words are not shown
  expect(bot.roundRefused).toEqual(round.refused);
  expect([round.saved, bot.roundSaved]).toEqual([4, 4]); // model items stored, same unit as the refused list
});

test("dependents: a refused part.add drops the link and the question that name its $ref (depends_on_refused); the rest is stored", async () => {
  const { db, pid } = await project();
  const before = (await loadSpec(db, pid)).parts.length;
  const g = stub([answer(
    [feature("$s2", "ขั้นใหม่"), role("$r", "ฝ่ายขาย"), item({ op: "link.add", kind: "next", from: "$s2", to: "STEP-001" })],
    { questions: [{ text: "ขั้นใหม่ทำอย่างไร", proposedAnswer: "ทำเอง", cases: [], about: "$s2" }, { text: "ฝ่ายขายทำอะไร", proposedAnswer: "ขาย", cases: [], about: "$r" }] },
  )]);
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect(round.status).toBe("applied");
  expect(g.calls.n).toBe(3); // the refusal asked for the one (light) correction, which repeated the same answer, so its fallback ran too (REQ-115)
  expect(round.refused!.map((r) => [(r as any).item, (r as any).reason, (r as any).ref])).toEqual([
    ["changes[0]", "unknown_kind", "$s2"], ["changes[2]", "depends_on_refused", "$s2"], ["questions[0]", "depends_on_refused", "$s2"],
  ]);
  const after = await loadSpec(db, pid);
  expect(after.parts.length).toBe(before + 2); // the role and the question about it
  expect(after.parts.map((p) => p.title)).toContain("ฝ่ายขาย");
  expect(round.questions).toHaveLength(1);
  expect(round.saved).toBe(2); // the role and the question; the link rows are not counted
});

test("store-level: an item that passes build() but the store refuses is dropped with its dependents after a retry; the rest is stored", async () => {
  const { db, pid } = await project();
  const before = await loadSpec(db, pid);
  const g = stub([answer([
    role("$ok", "ฝ่ายขาย"),
    item({ op: "part.add", ref: "$b", kind: "step", title: "ขั้นเสีย", body: { bogus: 1 } }),
    item({ op: "link.add", kind: "next", from: "STEP-001", to: "$b" }),
    item({ op: "link.add", kind: "shows", from: "STEP-001", to: "DATA-001" }),
  ])]);
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, g.calls.n]).toEqual(["applied", 1]);
  expect(round.refused!.map((r) => [(r as any).item, (r as any).reason])).toEqual([
    ["changes[1]", "invalid_change"], ["changes[2]", "depends_on_refused"], ["changes[3]", "invalid_change"],
  ]);
  const after = await loadSpec(db, pid);
  expect(after.parts.length).toBe(before.parts.length + 1);
  expect(after.links).toEqual(before.links);
});

test("E5b: the correction call fails (network) → the first answer's valid items are stored", async () => {
  const { db, pid } = await project();
  const before = (await loadSpec(db, pid)).parts.length;
  const g = stub([answer([role("$a", "ฝ่ายขาย"), feature("$f")]), new Error("connection reset")]);
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, round.reply, round.reason, round.note]).toEqual(["applied", null, null, null]);
  expect(round.refused).toEqual([expect.objectContaining({ item: "changes[1]", reason: "unknown_kind", kind: "feature" })]);
  expect((await loadSpec(db, pid)).parts.length).toBe(before + 1);
});

test("E5b: the correction is not the JSON → the first answer's valid items are stored too", async () => {
  const { db, pid } = await project();
  const before = (await loadSpec(db, pid)).parts.length;
  const g = stub([answer([role("$a", "ฝ่ายขาย"), feature("$f")]), "not json at all"]);
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, round.reply]).toEqual(["applied", null]);
  expect((await loadSpec(db, pid)).parts.length).toBe(before + 1);
});

test("all refused → changes_rejected, the same record, nothing stored, summary code kept", async () => {
  const { db, pid } = await project();
  const before = await loadSpec(db, pid);
  const g = stub([answer([feature("$f1", "หนึ่ง"), feature("$f2", "สอง")])]);
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, round.reply, round.changeSetId, round.reason, round.note]).toEqual(["changes_rejected", null, null, "unknown_kind", "feature"]);
  expect(round.refused!.map((r) => [(r as any).item, (r as any).reason, (r as any).title])).toEqual([
    ["changes[0]", "unknown_kind", "หนึ่ง"], ["changes[1]", "unknown_kind", "สอง"],
  ]);
  const bot = await rowOf(db, round.messageIds[1]!);
  expect([bot.roundStatus, bot.content, bot.roundReason, bot.roundNote]).toEqual(["changes_rejected", "", "unknown_kind", "feature"]);
  expect(bot.roundRefused).toEqual(round.refused);
  expect([round.saved, bot.roundSaved]).toEqual([0, 0]);
  expect(await loadSpec(db, pid)).toEqual(before);
});

test("nothing refused → as today: the reply is shown and roundRefused is null", async () => {
  const { db, pid } = await project();
  const g = stub([answer([role("$a", "ฝ่ายขาย")], {}, "เพิ่มฝ่ายขายแล้ว")]);
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, round.reply, round.refused, round.saved]).toEqual(["applied", "เพิ่มฝ่ายขายแล้ว", null, null]);
  const bot = await rowOf(db, round.messageIds[1]!);
  expect([bot.content, bot.roundRefused]).toEqual(["เพิ่มฝ่ายขายแล้ว", null]);
});

test("the user's own accept still applies alongside refused model items — whether one valid item is left or none", async () => {
  const { db, pid } = await project();
  const g = stub([answer([role("$a", "ฝ่ายขาย"), feature("$f")])]);
  const round = await runRound(db, g.gateway, pid, { message: MESSAGE, accept: ["Q-001"] }, { today: TODAY });
  expect(round.status).toBe("applied");
  const spec = await loadSpec(db, pid);
  expect(spec.parts.find((p) => p.key === "Q-001")!.body.status).toBe("answered");
  expect(spec.parts.map((p) => p.title)).toContain("ฝ่ายขาย");
  expect([round.refused!.length, round.saved]).toEqual([1, 1]); // the accepted question is the user's, not a model item

  const { db: db2, pid: pid2 } = await project();
  const g2 = stub([answer([feature("$f")])]);
  const none = await runRound(db2, g2.gateway, pid2, { message: MESSAGE, accept: ["Q-001"] }, { today: TODAY });
  expect([none.status, none.reply, typeof none.changeSetId, none.reason]).toEqual(["changes_rejected", null, "string", "unknown_kind"]);
  expect((await loadSpec(db2, pid2)).parts.find((p) => p.key === "Q-001")!.body.status).toBe("answered"); // D-023: the decision is kept
  expect((await rowOf(db2, none.messageIds[1]!)).roundRefused).toEqual(none.refused);
  expect(none.refused).toHaveLength(1);
  expect(none.saved).toBe(0);
});

test("AC-7: GET …/messages returns roundRefused with every field; 51 refusals → the first 50 and { item: more, count: 1 }", async () => {
  const db = await testDb();
  const app = createApp(db);
  const made = await app.request("/v1/projects", { method: "POST", headers: { ...BY, "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
  const pid = ((await made.json()) as any).id as string;
  const many = Array.from({ length: 51 }, (_, i) => feature(`$f${i}`, `ฟีเจอร์ ${i}`));
  await runRound(db, stub([answer(many)]).gateway, pid, { message: MESSAGE }, { today: TODAY });
  await runRound(db, stub([answer([role("$a", "ฝ่ายขาย"), feature("$f", "ฟีเจอร์เดียว")])]).gateway, pid, { message: MESSAGE }, { today: TODAY });

  const list = (await (await app.request(`/v1/projects/${pid}/messages`)).json()) as any[];
  const bots = list.filter((m) => m.role === "bot");
  const big = bots[0].roundRefused as any[];
  expect(big).toHaveLength(51);
  expect(big[49]).toMatchObject({ item: "changes[49]", reason: "unknown_kind" });
  expect(big[50]).toEqual({ item: "more", count: 1 });
  expect([big.length, bots[0].roundSaved, bots[1].roundSaved]).toEqual([51, 0, 1]);
  expect(bots[1].roundRefused).toEqual([{
    item: "changes[1]", op: "part.add", kind: "feature", ref: "$f", key: null, title: "ฟีเจอร์เดียว", reason: "unknown_kind",
    detail: "a feature cannot be added as a change — use questions / contradictions",
  }]);
  expect(list.filter((m) => m.role === "user").every((m) => m.roundRefused === null && m.roundSaved === null)).toBe(true); // present and null, not missing
});
