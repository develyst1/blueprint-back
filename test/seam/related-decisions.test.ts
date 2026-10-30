// SPEC-106 § REQ-112 (TASK-117): `relatedDecisions` / `relatedDecisionsMore` in a part's context, v1 (a label's snapshot) and v2 (the
// live spec). Built from TEST-106's spec (tests/harness/test-106/step2-changeset.mjs). No gateway, no CLI.
import { expect, test } from "bun:test";
import type { Db } from "../../src/db/client";
import { projects } from "../../src/db/schema";
import { confirmVersion } from "../../src/projects/service";
import { partContext } from "../../src/seam/context";
import { specContext } from "../../src/seam/spec";
import { applyChangeSet, loadSpec } from "../../src/spec/store";
import type { Change } from "../../src/spec/types";
import { testDb } from "../helpers/db";
import { passingQuiz } from "../helpers/quiz";

const origin = { stamp: "operator", date: "2026-10-30" } as const;
const part = (ref: string, kind: string, title: string, body: Record<string, unknown> = {}): Change => ({ op: "part.add", ref, kind, title, body, origin } as Change);
const link = (kind: string, from: string, to: string): Change => ({ op: "link.add", kind, from, to, origin } as Change);

// A work with 3 steps; SCR-001 takes part in an interaction under each step. Keys follow the order added.
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
];
const dec = (n: number): Change => part(`$d${n}`, "decision", `กฎ ${n}`, { rule: `กฎ ${n}` });
// TEST-106: DEC-001…003 cover STEP-002; DEC-004 and DEC-006 cover WRK-001; DEC-005 covers SCR-001.
const test106: Change[] = [
  ...flow, ...[1, 2, 3, 4, 5, 6].map(dec),
  link("covers", "$d1", "$s2"), link("covers", "$d2", "$s2"), link("covers", "$d3", "$s2"),
  link("covers", "$d4", "$w"), link("covers", "$d5", "$s"), link("covers", "$d6", "$w"),
];

async function project(changes: Change[]): Promise<{ db: Db; pid: string }> {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "Health Board" }).returning();
  await applyChangeSet(db, p!.id, { cause: { kind: "operator" }, changes });
  return { db, pid: p!.id };
}
const viewOf = (c: { relatedDecisions: { via: string; decision: { key: string } }[]; relatedDecisionsMore: boolean }) =>
  ({ related: c.relatedDecisions.map((r) => [r.decision.key, r.via]), more: c.relatedDecisionsMore });

const TEST106_RELATED = [["DEC-001", "STEP-002"], ["DEC-002", "STEP-002"], ["DEC-003", "STEP-002"], ["DEC-004", "WRK-001"], ["DEC-006", "WRK-001"]];

test("TEST-106's spec, v1 (after a label): SCR-001 → decisions [DEC-005], relatedDecisions DEC-001…003 via STEP-002 and DEC-004/006 via WRK-001", async () => {
  const { db, pid } = await project(test106);
  await passingQuiz(db, pid);
  await confirmVersion(db, pid, "operator");
  const ctx = await partContext(db, pid, 1, "SCR-001");
  expect(ctx.decisions.map((d) => d.key)).toEqual(["DEC-005"]);
  expect(ctx.flows[0]!.at).toEqual(["STEP-001", "STEP-002", "STEP-003"]);
  expect(viewOf(ctx)).toEqual({ related: TEST106_RELATED, more: false });
  expect(ctx.relatedDecisions[0]!.decision).toMatchObject({ key: "DEC-001", kind: "decision", title: "กฎ 1" });
});

test("TEST-106's spec, v2 (the live spec): the same answer; a later edit shows at once, a frozen v1 would not", async () => {
  const { db, pid } = await project(test106);
  const ctx = await specContext(db, pid, "SCR-001");
  expect(ctx.decisions.map((d) => d.key)).toEqual(["DEC-005"]);
  expect(viewOf(ctx)).toEqual({ related: TEST106_RELATED, more: false });
  const covers = (await loadSpec(db, pid)).links.find((l) => l.kind === "covers" && l.fromKey === "DEC-004" && l.toKey === "WRK-001")!;
  await applyChangeSet(db, pid, { cause: { kind: "operator" }, changes: [{ op: "link.remove", id: covers.id }] });
  expect(viewOf(await specContext(db, pid, "SCR-001")).related.map((r) => r[0])).toEqual(["DEC-001", "DEC-002", "DEC-003", "DEC-006"]);
});

test("a part whose flows carry no other decision → relatedDecisions [] and relatedDecisionsMore false", async () => {
  const { db, pid } = await project([...flow, part("$x", "system", "ระบบอื่น"), dec(1), link("covers", "$d1", "$s")]);
  expect(viewOf(await specContext(db, pid, "SYS-001"))).toEqual({ related: [], more: false }); // in no flow at all
  expect(viewOf(await specContext(db, pid, "SCR-001"))).toEqual({ related: [], more: false }); // DEC-001 is its own `decisions`
});

test("a decision covering two of the flow's steps appears once, via the lower key", async () => {
  const { db, pid } = await project([...flow, dec(1), link("covers", "$d1", "$s3"), link("covers", "$d1", "$s2")]);
  expect(viewOf(await specContext(db, pid, "SCR-001"))).toEqual({ related: [["DEC-001", "STEP-002"]], more: false });
});

test("51 related decisions → 50 returned (sorted by key), relatedDecisionsMore true; exactly 50 → false", async () => {
  const many = (n: number) => [...flow, ...Array.from({ length: n }, (_, i) => dec(i + 1)), ...Array.from({ length: n }, (_, i) => link("covers", `$d${i + 1}`, "$w"))];
  const over = await project(many(51));
  const ctx = await specContext(over.db, over.pid, "SCR-001");
  expect(ctx.relatedDecisions).toHaveLength(50);
  expect(ctx.relatedDecisions.map((r) => r.decision.key)).toEqual(Array.from({ length: 50 }, (_, i) => `DEC-${String(i + 1).padStart(3, "0")}`));
  expect(ctx.relatedDecisionsMore).toBe(true);
  const exact = await project(many(50));
  expect(viewOf(await specContext(exact.db, exact.pid, "SCR-001"))).toMatchObject({ more: false });
});

// E17 (REQ-112 AC-5): a card on a work gets the rules on that work's steps.
test("AC-5: the context of WRK-001 (v1 and v2) keeps decisions [DEC-004, DEC-006] and gains DEC-001…003 via STEP-002", async () => {
  const { db, pid } = await project(test106);
  const v2 = await specContext(db, pid, "WRK-001");
  expect(v2.decisions.map((d) => d.key)).toEqual(["DEC-004", "DEC-006"]);
  expect(viewOf(v2)).toEqual({ related: [["DEC-001", "STEP-002"], ["DEC-002", "STEP-002"], ["DEC-003", "STEP-002"]], more: false });
  await passingQuiz(db, pid);
  await confirmVersion(db, pid, "operator");
  const v1 = await partContext(db, pid, 1, "WRK-001");
  expect(v1.decisions.map((d) => d.key)).toEqual(["DEC-004", "DEC-006"]);
  expect(viewOf(v1)).toEqual(viewOf(v2));
});

test("E17 leaves SCR-001's answer exactly as in round 1 (same list, same via, same order)", async () => {
  const { db, pid } = await project(test106);
  const ctx = await specContext(db, pid, "SCR-001");
  expect(ctx.relatedDecisions.map((r) => [r.decision.key, r.via])).toEqual(TEST106_RELATED);
  expect(ctx.relatedDecisionsMore).toBe(false);
});

test("a decision anchor that covers a work also gets that work's steps' rules, minus itself", async () => {
  const { db, pid } = await project(test106);
  const ctx = await specContext(db, pid, "DEC-004");
  expect(ctx.relatedDecisions.map((r) => [r.decision.key, r.via])).toEqual(
    [["DEC-001", "STEP-002"], ["DEC-002", "STEP-002"], ["DEC-003", "STEP-002"], ["DEC-006", "WRK-001"]]);
  expect(ctx.relatedDecisions.some((r) => r.decision.key === "DEC-004")).toBe(false);
});
