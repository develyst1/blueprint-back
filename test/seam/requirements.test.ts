// SPEC-115 (REQ-118, TASK-145): `requirements` in every part's context, v1 (a label's snapshot) and v2 (the live spec). The 8
// requirements are TEST-106 phase 2's (titles: tests/harness/test-106/phase2/hand.mjs, texts: the lines of its spec.txt), copied here.
import { expect, test } from "bun:test";
import type { Db } from "../../src/db/client";
import { projects } from "../../src/db/schema";
import { confirmVersion } from "../../src/projects/service";
import { contextIn, partContext } from "../../src/seam/context";
import { specContext } from "../../src/seam/spec";
import { applyChangeSet, loadSpec, revisionOf } from "../../src/spec/store";
import type { Change } from "../../src/spec/types";
import { testDb } from "../helpers/db";
import { passingQuiz } from "../helpers/quiz";

const origin = { stamp: "operator", date: "2026-10-30" } as const;
const part = (ref: string, kind: string, title: string, body: Record<string, unknown> = {}): Change => ({ op: "part.add", ref, kind, title, body, origin } as Change);
const link = (kind: string, from: string, to: string): Change => ({ op: "link.add", kind, from, to, origin } as Change);

const EIGHT: [string, string][] = [
  ["สิ่งที่สร้าง: I-Space Health Board", "ชื่อ: I-Space Health Board — หน้าเว็บเดียว ดูว่าบริการของ I-Space ตัวไหนเปิดอยู่"],
  ["1. บริการ 4 ตัวที่แสดง", "1. แสดง 4 บริการ: Blueprint API (http://127.0.0.1:4200/health), Blueprint เว็บ (http://127.0.0.1:3100), CAW API (http://127.0.0.1:4500/health), CAW เว็บ (http://127.0.0.1:3500)."],
  ["2. สิ่งที่แสดงต่อบริการ", "2. แต่ละบริการแสดง: ชื่อ · สถานะ \"ทำงาน\" (เขียว) หรือ \"ไม่ตอบ\" (แดง) · เวลาตอบเป็น ms · เวลาที่เช็คล่าสุด."],
  ["3. เช็คใหม่ทุก 10 วินาที + ปุ่มเช็คตอนนี้", "3. เช็คใหม่เองทุก 10 วินาที และมีปุ่ม \"เช็คตอนนี้\"."],
  ["4. ไม่ตอบใน 3 วินาที = ไม่ตอบ", "4. ถ้าบริการไม่ตอบภายใน 3 วินาที ให้ถือว่า \"ไม่ตอบ\"."],
  ["5. รันที่ :3900 ไม่ต้อง login ไม่มีฐานข้อมูล", "5. รันในเครื่องที่ http://127.0.0.1:3900 ไม่ต้อง login ไม่ต้องมีฐานข้อมูล."],
  ["6. ข้อความภาษาไทย", "6. ข้อความบนหน้าเป็นภาษาไทย."],
  ["ไม่ทำ", "ไม่ทำ: login, การแจ้งเตือน, เก็บประวัติ, deploy."],
];
const reqs = (items = EIGHT): Change[] => items.map(([title, text], i) => part(`$q${i}`, "requirement", title, { text }));

// TEST-106's flow: a work, 3 steps, SCR-001 under all 3, and decisions DEC-001…003 on STEP-002, DEC-004/006 on the work, DEC-005 on the screen.
const flow: Change[] = [
  part("$w", "work", "Health Board", { goal: "ดูสถานะบริการ" }),
  part("$r", "role", "ผู้ดูแล", { duty: "ดู" }),
  part("$s", "screen", "หน้า Health Board"),
  part("$s1", "step", "เปิดหน้า", { ends: false }), part("$s2", "step", "เช็คสถานะ", { ends: false }), part("$s3", "step", "แสดงสถานะ", { ends: true }),
  link("has_step", "$w", "$s1"), link("has_step", "$w", "$s2"), link("has_step", "$w", "$s3"),
  ...[1, 2, 3].flatMap((i) => [
    part(`$i${i}`, "interaction", `ทำ ${i}`, { text: `ทำ ${i}` }),
    link("has_interaction", `$s${i}`, `$i${i}`), link("from", `$i${i}`, "$r"), link("to", `$i${i}`, "$s"),
  ]),
  ...[1, 2, 3, 4, 5, 6].map((n) => part(`$d${n}`, "decision", `กฎ ${n}`, { rule: `กฎ ${n}` })),
  link("covers", "$d1", "$s2"), link("covers", "$d2", "$s2"), link("covers", "$d3", "$s2"),
  link("covers", "$d4", "$w"), link("covers", "$d5", "$s"), link("covers", "$d6", "$w"),
];

async function project(changes: Change[]): Promise<{ db: Db; pid: string }> {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "Health Board" }).returning();
  await applyChangeSet(db, p!.id, { cause: { kind: "operator" }, changes });
  return { db, pid: p!.id };
}
const keysOf = (parts: { key: string }[]) => parts.map((p) => p.key);
const typed = (parts: { title: string; body: Record<string, unknown> }[]) => parts.map((p) => [p.title, p.body.text]);
const KEYS = Array.from({ length: 8 }, (_, i) => `REQ-00${i + 1}`);
// everything in a context except the requirements list and the head; the ids differ between two projects, so they are left out
const PER_PROJECT = new Set(["id", "createdIn", "updatedIn", "createdAt", "updatedAt", "sourceId"]);
const rest = (c: any) => JSON.parse(JSON.stringify({ part: c.part, neighbours: c.neighbours, decisions: c.decisions, flows: c.flows,
  questions: c.questions, relatedDecisions: c.relatedDecisions, relatedDecisionsMore: c.relatedDecisionsMore },
  (k, v) => (PER_PROJECT.has(k) ? undefined : v)));

test("(a) AC-1, v2: a spec of only the 8 → REQ-001 and REQ-005 each carry all 8, in order, with the typed title and text", async () => {
  const { db, pid } = await project(reqs());
  for (const anchor of ["REQ-001", "REQ-005"]) {
    const c = await specContext(db, pid, anchor);
    expect([anchor, keysOf(c.requirements)]).toEqual([anchor, KEYS]);
    expect(typed(c.requirements as any)).toEqual(EIGHT);
  }
});

test("(b) AC-1, mixed: the 8 plus the flow → WRK-001 and SCR-001 carry the same 8; flows and relatedDecisions as without them", async () => {
  const mixed = await project([...flow, ...reqs()]);
  const plain = await project(flow);
  for (const anchor of ["WRK-001", "SCR-001"]) {
    const c = await specContext(mixed.db, mixed.pid, anchor);
    expect(typed(c.requirements as any)).toEqual(EIGHT);
    expect(keysOf(c.requirements)).toEqual(KEYS);
    const before = await specContext(plain.db, plain.pid, anchor);
    expect(c.flows).toEqual(before.flows);
    expect(c.relatedDecisions.map((r) => [r.decision.key, r.via])).toEqual(before.relatedDecisions.map((r) => [r.decision.key, r.via]));
    expect(c.relatedDecisions.length).toBeGreaterThan(0);
  }
});

test("(c) A1, v1: after a label, partContext of WRK-001 carries the 8", async () => {
  const { db, pid } = await project([...flow, ...reqs()]);
  await passingQuiz(db, pid);
  await confirmVersion(db, pid, "operator");
  const c = await partContext(db, pid, 1, "WRK-001");
  expect(keysOf(c.requirements)).toEqual(KEYS);
  expect(typed(c.requirements as any)).toEqual(EIGHT);
});

test("(d) AC-5: a spec with no requirement → requirements [], and every other field is what it is with them", async () => {
  const none = await project(flow);
  const some = await project([...flow, ...reqs()]);
  for (const anchor of ["WRK-001", "SCR-001", "STEP-002", "DEC-004"]) {
    const a = await specContext(none.db, none.pid, anchor);
    const b = await specContext(some.db, some.pid, anchor);
    expect(a.requirements).toEqual([]);
    expect(rest(a)).toEqual(rest(b));
  }
  const v1 = await (async () => { await passingQuiz(none.db, none.pid); await confirmVersion(none.db, none.pid, "operator"); return partContext(none.db, none.pid, 1, "SCR-001"); })();
  expect(v1.requirements).toEqual([]);
});

test("(e) AC-4: part.update of REQ-003's text shows in the next context (any key), revision up by 1", async () => {
  const { db, pid } = await project([...flow, ...reqs()]);
  const before = await revisionOf(db, pid);
  await applyChangeSet(db, pid, { cause: { kind: "operator" }, changes: [{ op: "part.update", key: "REQ-003", body: { text: "เช็คใหม่ทุก 5 วินาที" } } as Change] });
  const c = await specContext(db, pid, "STEP-002");
  expect(c.requirements.find((r) => r.key === "REQ-003")!.body.text).toBe("เช็คใหม่ทุก 5 วินาที");
  expect(c.requirements.find((r) => r.key === "REQ-004")!.body.text).toBe(EIGHT[3]![1]);
  expect(c.revision).toBe(before + 1);
});

test("(f) sort: 10 requirements come out REQ-001…REQ-010 (REQ-010 after REQ-009), whatever order the parts arrive in", async () => {
  const ten = Array.from({ length: 10 }, (_, i): [string, string] => [`ข้อ ${i + 1}`, `ข้อความ ${i + 1}`]);
  const { db, pid } = await project([...flow, ...reqs(ten)]);
  const want = Array.from({ length: 10 }, (_, i) => `REQ-${String(i + 1).padStart(3, "0")}`);
  expect(keysOf((await specContext(db, pid, "WRK-001")).requirements)).toEqual(want);
  const spec = await loadSpec(db, pid);
  const shuffled = { parts: [...spec.parts].reverse(), links: spec.links };
  expect(keysOf(contextIn(shuffled, "WRK-001")!.requirements)).toEqual(want);
});
