// REQ-110 / SPEC-105 (TASK-109): the prompt lists the kinds the server accepts, a rejected round never shows the model's
// words and stores why, a timeout is not retried, and the reason of a failed bot row is kept. Stub gateways only — no live call.
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app";
import type { Db } from "../../src/db/client";
import { changeSets, messages, projects } from "../../src/db/schema";
import { createGateway } from "../../src/gateway/client";
import { kindsBlock, MODEL_KINDS, SYSTEM_PROMPT } from "../../src/interview/context";
import { runRound } from "../../src/interview/round";
import { LINK_KIND_NAMES, PART_KIND_NAMES } from "../../src/spec/registry";
import { applyChangeSet, loadSpec } from "../../src/spec/store";
import { BY } from "../helpers/by";
import { testDb } from "../helpers/db";

const TODAY = "2026-10-29";
const operator = { stamp: "operator", date: "2026-10-08" } as const;

// A gateway whose POST /chat answers from a queue (the last answer repeats); `calls` counts every request.
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
const reply = (changes: unknown[], text = "บันทึกให้แล้วครับ") => JSON.stringify({ reply: text, changes, questions: [], contradictions: [] });
const add = (kind: string, extra: Record<string, unknown> = {}) =>
  ({ change: { op: "part.add", ref: "$x", kind, title: "ฟีเจอร์ใหม่", body: {}, ...extra }, saidBy: "user", quote: "ผมอยากได้ฟีเจอร์ใหม่ ช่วยเพิ่มให้หน่อย", sure: true });
const MESSAGE = "ผมอยากได้ฟีเจอร์ใหม่ ช่วยเพิ่มให้หน่อย";

async function project(): Promise<{ db: Db; pid: string }> {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้อง" }).returning();
  return { db, pid: p!.id };
}
const rowOf = async (db: Db, id: string) => (await db.select().from(messages).where(eq(messages.id, id)))[0]!;
const counts = async (db: Db, pid: string) =>
  [(await loadSpec(db, pid)).parts.length, (await db.select().from(changeSets).where(eq(changeSets.projectId, pid))).length];

// --- E1: the prompt ------------------------------------------------------------------------------------------

test("E1: the prompt holds every model kind and every link kind, and no kind outside the registry", () => {
  const block = kindsBlock();
  expect(SYSTEM_PROMPT).toContain(block);
  const lines = block.split("\n");
  const partKinds = lines.filter((l) => /^- \w+ \{/.test(l)).map((l) => l.slice(2, l.indexOf(" {")));
  const linkLines = lines.filter((l) => /^- \w+: /.test(l));
  const linkKinds = linkLines.map((l) => l.slice(2, l.indexOf(":")));

  expect([...partKinds].sort()).toEqual([...MODEL_KINDS].sort()); // exactly what the server lets the model add
  expect([...linkKinds].sort()).toEqual([...LINK_KIND_NAMES].sort()); // every link kind of the registry
  for (const k of partKinds) expect(PART_KIND_NAMES as readonly string[]).toContain(k);
  for (const l of linkLines) { // every kind named as an end is in the registry (or "any")
    const ends = l.slice(l.indexOf(": ") + 2).replace(/ \[.*$/, "").split(" → ").flatMap((side) => side.split("|"));
    for (const e of ends) expect(["any", ...PART_KIND_NAMES]).toContain(e);
  }
  for (const notAddable of ["question", "contradiction", "requirement", "feature"]) expect(partKinds).not.toContain(notAddable);
  expect(block).not.toContain("requirement"); // a person's, never the model's (SPEC-104 D6)
  // body fields come from the zod shapes: required vs optional (`?`, also for a defaulted field)
  expect(block).toContain("- interaction { text: string, reply?: string }");
  expect(block).toContain("- step { ends?: boolean }");
  expect(block).toContain("- work { goal?: string }");
  expect(block).toContain("- next: step → step [ordered] [labelled]");
  expect(block).toContain("ห้ามใช้ kind อื่นนอกจากนี้ — ถ้าไม่เข้ากับ kind ไหน ให้ถามเป็น question");
});

// --- E2: a rejected round is honest -------------------------------------------------------------------------

test("E2 / AC-3: a model that proposes `feature` (twice) → changes_rejected, no reply text, unknown_kind + note, nothing stored", async () => {
  const { db, pid } = await project();
  const { gateway, calls } = stub([reply([add("feature")])]); // the correction repeats the same answer
  const round = await runRound(db, gateway, pid, { message: MESSAGE }, { today: TODAY });

  expect(calls.n).toBe(3); // the round + its one (light) correction + that correction's fallback on the project's model (REQ-115)
  expect([round.status, round.reply, round.changeSetId, round.reason, round.note]).toEqual(["changes_rejected", null, null, "unknown_kind", "feature"]);
  const bot = await rowOf(db, round.messageIds[1]!);
  expect([bot.roundStatus, bot.content, bot.roundReason, bot.roundNote]).toEqual(["changes_rejected", "", "unknown_kind", "feature"]);
  expect(JSON.stringify(bot)).not.toContain("บันทึกให้แล้ว"); // the model's "saved" never reaches the row
  expect(await counts(db, pid)).toEqual([0, 0]); // 0 parts, 0 change sets
});

test("E2: an unknown link kind is rejected the same way, and a long kind name is cut to 60 characters", async () => {
  const { db, pid } = await project();
  const link = { change: { op: "link.add", kind: "x".repeat(100), from: "$a", to: "$b" }, saidBy: "user", quote: MESSAGE, sure: true };
  const round = await runRound(db, stub([reply([link])]).gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, round.reply, round.reason, round.note]).toEqual(["changes_rejected", null, "unknown_kind", "x".repeat(60)]);
});

test("E2: a provenance refusal → needs_user_words", async () => {
  const { db, pid } = await project();
  await applyChangeSet(db, pid, { cause: { kind: "operator" }, changes: [{ op: "part.add", ref: "$s", kind: "step", title: "ส่งคำขอ", body: {}, origin: operator }] });
  const removal = { change: { op: "part.remove", key: "STEP-001" }, saidBy: "inferred", sure: true };
  const round = await runRound(db, stub([reply([removal])]).gateway, pid, { message: "ลบขั้นตอนให้หน่อย" }, { today: TODAY });
  expect([round.status, round.reply, round.reason, round.note]).toEqual(["changes_rejected", null, "needs_user_words", null]);
  expect((await rowOf(db, round.messageIds[1]!)).content).toBe("");
  expect((await loadSpec(db, pid)).parts.map((p) => p.key)).toEqual(["STEP-001"]); // nothing removed
});

test("E2: any other validation refusal → invalid_change", async () => {
  const { db, pid } = await project();
  const bad = add("step", { body: { nope: 1 } }); // a step body with a field the registry does not have
  const round = await runRound(db, stub([reply([bad])]).gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, round.reply, round.reason, round.note]).toEqual(["changes_rejected", null, "invalid_change", null]);
});

test("E2: a correction that is not the JSON → protocol", async () => {
  const { db, pid } = await project();
  const { gateway, calls } = stub([reply([add("feature")]), "ขออภัยครับ ผมจะลองใหม่"]);
  const round = await runRound(db, gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect(calls.n).toBe(3); // the round + the light correction + its fallback (the stub repeats the same non-JSON) — REQ-115
  expect([round.status, round.reply, round.reason, round.note]).toEqual(["changes_rejected", null, "protocol", null]);
  expect(await rowOf(db, round.messageIds[1]!)).toMatchObject({ content: "", roundReason: "protocol" });
});

test("E2: if the correction call itself fails, the round keeps the code of the first refusal", async () => {
  const { db, pid } = await project();
  const { gateway } = stub([reply([add("feature")]), new Error("down"), new Error("down")]);
  const round = await runRound(db, gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect([round.status, round.reply, round.reason, round.note]).toEqual(["changes_rejected", null, "unknown_kind", "feature"]);
});

test("E2: a rejected round that also carries the user's own decisions keeps them and still shows no model text", async () => {
  const { db, pid } = await project();
  await applyChangeSet(db, pid, { cause: { kind: "operator" }, changes: [
    { op: "part.add", ref: "$q", kind: "question", title: "ใครอนุมัติ", body: { text: "ใครอนุมัติ", proposedAnswer: "หัวหน้า", status: "open" }, origin: { stamp: "team-proposed", date: "2026-10-08" } }] });
  const round = await runRound(db, stub([reply([add("feature")])]).gateway, pid,
    { message: MESSAGE, answers: [{ key: "Q-001", text: "ผู้ดูแลห้องเป็นคนอนุมัติ" }] }, { today: TODAY });
  expect([round.status, round.reply, round.reason, typeof round.changeSetId]).toEqual(["changes_rejected", null, "unknown_kind", "string"]);
  expect(await rowOf(db, round.messageIds[1]!)).toMatchObject({ content: "", roundReason: "unknown_kind", roundNote: "feature", changeSetId: round.changeSetId });
  expect((await loadSpec(db, pid)).parts.find((p) => p.key === "Q-001")!.body).toMatchObject({ status: "answered" });
});

// --- E3 / E4: timeouts and stored reasons -----------------------------------------------------------------

test("E3 / AC-4: a gateway that is too slow → exactly 1 call, bot_could_not_answer, reason timeout", async () => {
  const { db, pid } = await project();
  let calls = 0;
  const gateway = createGateway({
    baseUrl: "https://gateway.example.com", timeoutMs: 60, firstAnswerTimeoutMs: 60,
    fetch: () => { calls++; return new Promise<Response>(() => {}); }, // never answers
  });
  const t0 = Date.now();
  const round = await runRound(db, gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect(calls).toBe(1); // not 2 (the client's R8 retry) and not 4
  expect(Date.now() - t0).toBeLessThan(1_000);
  expect([round.status, round.reply, round.reason, round.note]).toEqual(["bot_could_not_answer", null, "timeout", null]);
  expect(await rowOf(db, round.messageIds[1]!)).toMatchObject({ roundStatus: "bot_could_not_answer", content: "", roundReason: "timeout", roundNote: null });
});

test("E3: the client does not retry after a timeout, but still retries a network failure once (R8)", async () => {
  const slow = { n: 0 };
  const g1 = createGateway({ baseUrl: "https://gateway.example.com", timeoutMs: 40, fetch: () => { slow.n++; return new Promise<Response>(() => {}); } });
  expect(await g1.chat({ model: "tier:small", creativity: 0.5, messages: [{ role: "user", content: "hi" }] })).toEqual({ ok: false, reason: "timeout" });
  expect(slow.n).toBe(1);

  const down = { n: 0 };
  const g2 = createGateway({ baseUrl: "https://gateway.example.com", fetch: async () => { down.n++; throw new Error("ECONNREFUSED"); } });
  expect(await g2.chat({ model: "tier:small", creativity: 0.5, messages: [{ role: "user", content: "hi" }] })).toEqual({ ok: false, reason: "network" });
  expect(down.n).toBe(2); // R8 unchanged for everything but a timeout
});

test("E4: a network failure is stored as the reason of the failed bot row too", async () => {
  const { db, pid } = await project();
  const { gateway, calls } = stub([new Error("ECONNREFUSED")]);
  const round = await runRound(db, gateway, pid, { message: MESSAGE }, { today: TODAY });
  expect(calls.n).toBe(2); // the client's one retry
  expect([round.status, round.reason]).toEqual(["bot_could_not_answer", "network"]);
  expect(await rowOf(db, round.messageIds[1]!)).toMatchObject({ roundStatus: "bot_could_not_answer", roundReason: "network" });
});

test("an applied round has no reason or note", async () => {
  const { db, pid } = await project();
  const role = { change: { op: "part.add", ref: "$r", kind: "role", title: "ฝ่ายบัญชี", body: {} }, saidBy: "user", quote: "ต้องมีฝ่ายบัญชีในระบบด้วยนะ", sure: true };
  const round = await runRound(db, stub([reply([role])]).gateway, pid, { message: "ต้องมีฝ่ายบัญชีในระบบด้วยนะ" }, { today: TODAY });
  expect([round.status, round.reply, round.reason, round.note]).toEqual(["applied", "บันทึกให้แล้วครับ", null, null]);
  expect(await rowOf(db, round.messageIds[1]!)).toMatchObject({ roundReason: null, roundNote: null });
});

test("GET …/messages returns roundReason / roundNote, and null on old-style rows", async () => {
  const db = await testDb();
  const app = createApp(db);
  const made = await app.request("/v1/projects", { method: "POST", headers: { ...BY, "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
  const pid = ((await made.json()) as any).id as string;
  const old = (offset: number) => ({ projectId: pid, creativity: 0.5, model: "m", createdAt: new Date(Date.now() - offset) });
  await db.insert(messages).values([
    { ...old(3000), role: "user", content: "ถาม" },
    { ...old(2000), role: "bot", content: "ตอบแล้ว", roundStatus: "applied" }, // a row as written before REQ-110
    { ...old(1000), role: "bot", content: "", roundStatus: "changes_rejected", roundReason: "unknown_kind", roundNote: "feature" },
    { ...old(500), role: "bot", content: "", roundStatus: "bot_could_not_answer", roundReason: "timeout" },
  ]);
  const list = (await (await app.request(`/v1/projects/${pid}/messages`)).json()) as any[];
  expect(list.map((m) => [m.role, m.roundStatus, m.roundReason, m.roundNote])).toEqual([
    ["user", null, null, null], ["bot", "applied", null, null],
    ["bot", "changes_rejected", "unknown_kind", "feature"], ["bot", "bot_could_not_answer", "timeout", null],
  ]);
  expect(list[1]).toHaveProperty("roundReason", null); // present and null, not missing
});
