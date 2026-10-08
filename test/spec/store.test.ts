import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/db/client";
import { changes, changeSets, parts, projects } from "../../src/db/schema";
import { UndoConflict, ValidationError } from "../../src/spec/errors";
import { applyChangeSet, loadSpec, partHistory, undoChangeSet } from "../../src/spec/store";
import type { Cause, Change } from "../../src/spec/types";
import { testDb } from "../helpers/db";

const origin = { stamp: "operator", date: "2026-10-08" } as const;
const operator: Cause = { kind: "operator" };

async function setup() {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "x" }).returning();
  return { db, pid: p!.id };
}

function apply(db: Db, pid: string, changes: Change[], cause: Cause = operator) {
  return applyChangeSet(db, pid, { cause, changes });
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error("expected a rejection");
}

const step = (ref: string, title: string): Change =>
  ({ op: "part.add", ref, kind: "step", title, body: {}, origin });

test("AC-2: a Thai title round-trips byte-identical, with its origin and key", async () => {
  const { db, pid } = await setup();
  const { changeSetId } = await apply(db, pid, [step("$s", "ส่งคำขอจอง")]);
  const { parts: ps } = await loadSpec(db, pid);
  expect(ps).toHaveLength(1);
  expect(ps[0]!.key).toBe("STEP-001");
  expect(Buffer.from(ps[0]!.title).equals(Buffer.from("ส่งคำขอจอง"))).toBe(true);
  expect(ps[0]!.origin).toEqual(origin);
  expect(ps[0]!.createdIn).toBe(changeSetId);
});

test("temp refs resolve within one set; an ordered link gets position 1", async () => {
  const { db, pid } = await setup();
  const { keys } = await apply(db, pid, [
    { op: "part.add", ref: "$w", kind: "work", title: "จองห้องประชุม", body: {}, origin },
    step("$s", "ค้นหาห้องว่าง"),
    { op: "link.add", kind: "has_step", from: "$w", to: "$s", origin },
  ]);
  expect(keys).toEqual({ $w: "WRK-001", $s: "STEP-001" });
  const { links } = await loadSpec(db, pid);
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({ kind: "has_step", fromKey: "WRK-001", toKey: "STEP-001", position: 1, label: null });
});

test("AC-9: a bad 2nd change writes nothing and names index 1", async () => {
  const { db, pid } = await setup();
  const err = await caught(apply(db, pid, [
    step("$s", "x"),
    { op: "link.add", kind: "shows", from: "$s", to: "$s", origin },
  ]));
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).index).toBe(1);
  expect((err as ValidationError).message).toMatch(/step/);
  expect(await loadSpec(db, pid)).toEqual({ parts: [], links: [] });
  expect(await db.select().from(changeSets)).toHaveLength(0);
});

test("AC-7: removing a part removes its links; undo brings all back with the same ids", async () => {
  const { db, pid } = await setup();
  await apply(db, pid, [
    { op: "part.add", ref: "$i", kind: "interaction", title: "กดค้นหา", body: { text: "กดค้นหา" }, origin },
    { op: "part.add", ref: "$s", kind: "screen", title: "หน้าค้นหาห้อง", body: {}, origin },
    { op: "part.add", ref: "$d", kind: "data", title: "Room", body: {}, origin },
    { op: "link.add", kind: "from", from: "$i", to: "$s", origin },
    { op: "link.add", kind: "shows", from: "$s", to: "$d", origin },
  ]);
  const before = await loadSpec(db, pid);
  expect(before.links).toHaveLength(2);

  const removal = await apply(db, pid, [{ op: "part.remove", key: "SCR-001" }]);
  const after = await loadSpec(db, pid);
  expect(after.parts.map((p) => p.key)).toEqual(["DATA-001", "INT-001"]);
  expect(after.links).toHaveLength(0);

  await undoChangeSet(db, pid, removal.changeSetId);
  const restored = await loadSpec(db, pid);
  expect(restored.parts.map((p) => p.key)).toEqual(["DATA-001", "INT-001", "SCR-001"]);
  expect(restored.links.map((l) => l.id).sort()).toEqual(before.links.map((l) => l.id).sort());
  expect(restored).toEqual(before);
});

test("AC-8: undo refuses when a part was changed again, and changes nothing", async () => {
  const { db, pid } = await setup();
  const a = await apply(db, pid, [step("$s", "ก")]);
  await apply(db, pid, [{ op: "part.update", key: "STEP-001", title: "ข" }]);
  const err = await caught(undoChangeSet(db, pid, a.changeSetId));
  expect(err).toBeInstanceOf(UndoConflict);
  expect((err as UndoConflict).parts).toEqual([{ key: "STEP-001", title: "ข" }]);
  const { parts: ps } = await loadSpec(db, pid);
  expect(ps.map((p) => p.title)).toEqual(["ข"]);
  expect(await db.select().from(changeSets)).toHaveLength(2);
});

test("AC-6: a part's history lists every change with its cause, removed part included", async () => {
  const { db, pid } = await setup();
  await apply(db, pid, [step("$s", "ก")], { kind: "operator" });
  await apply(db, pid, [{ op: "part.update", key: "STEP-001", title: "ข" }], { kind: "message", ref: "m1" });
  await apply(db, pid, [{ op: "part.remove", key: "STEP-001" }]);
  const h = await partHistory(db, pid, "STEP-001");
  expect(h.map((e) => e.op)).toEqual(["add", "update", "remove"]);
  expect(h.map((e) => e.cause)).toEqual([{ kind: "operator" }, { kind: "message", ref: "m1" }, { kind: "operator" }]);
  expect(h.every((e) => e.entity === "part:STEP-001")).toBe(true);
  expect(h[1]!.before).toMatchObject({ title: "ก" });
  expect(h[1]!.after).toMatchObject({ title: "ข" });
});

test("AC-6 clarified: a part's history includes every change to a link touching it", async () => {
  const { db, pid } = await setup();
  await apply(db, pid, [
    { op: "part.add", ref: "$w", kind: "work", title: "w", body: {}, origin },
    step("$s", "s"),
  ]);
  await apply(db, pid, [{ op: "link.add", kind: "has_step", from: "WRK-001", to: "STEP-001", origin }],
    { kind: "message", ref: "m2" });
  const id = (await loadSpec(db, pid)).links[0]!.id;
  await apply(db, pid, [{ op: "link.update", id, position: 5 }]);
  await apply(db, pid, [{ op: "link.remove", id }]);

  const step1 = await partHistory(db, pid, "STEP-001");
  expect(step1.map((e) => e.op)).toEqual(["add", "link_add", "link_update", "link_remove"]);
  expect(step1[1]!.cause).toEqual({ kind: "message", ref: "m2" });
  expect(step1[1]!.entity).toBe(`link:${id}`);
  const work1 = await partHistory(db, pid, "WRK-001");
  expect(work1.map((e) => e.op)).toEqual(["add", "link_add", "link_update", "link_remove"]);
  expect(work1.slice(1)).toEqual(step1.slice(1));
});

test("AC-9 clarified: an empty change list is refused and writes nothing", async () => {
  const { db, pid } = await setup();
  const err = await caught(apply(db, pid, []));
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).index).toBeNull();
  expect(await db.select().from(changeSets)).toHaveLength(0);
});

test("keys are never reused, not after a remove, not after an undo", async () => {
  const { db, pid } = await setup();
  const first = await apply(db, pid, [step("$a", "a")]);
  await apply(db, pid, [step("$b", "b")]);
  await apply(db, pid, [{ op: "part.remove", key: "STEP-002" }]);
  expect((await apply(db, pid, [step("$c", "c")])).keys).toEqual({ $c: "STEP-003" });
  await undoChangeSet(db, pid, first.changeSetId);
  expect((await loadSpec(db, pid)).parts.map((p) => p.key)).toEqual(["STEP-003"]);
  expect((await apply(db, pid, [step("$d", "d")])).keys).toEqual({ $d: "STEP-004" });
});

test("ordering: STEP-999 sorts before STEP-1000", async () => {
  const { db, pid } = await setup();
  // Test setup only: rows written straight to the tables, with the change set that made them.
  const [cs] = await db.insert(changeSets).values({ projectId: pid, causeKind: "operator" }).returning();
  for (const [seq, key] of [[1, "STEP-1000"], [2, "STEP-999"]] as const) {
    const form = { key, kind: "step", title: key, body: { ends: false }, origin, removed: false };
    await db.insert(parts).values({ projectId: pid, key, kind: "step", title: key, body: { ends: false }, origin });
    await db.insert(changes).values({ changeSetId: cs!.id, seq, entity: `part:${key}`, before: null, after: form });
  }
  expect((await loadSpec(db, pid)).parts.map((p) => p.key)).toEqual(["STEP-999", "STEP-1000"]);
  expect(await db.select({ key: parts.key }).from(parts).where(eq(parts.projectId, pid))).toHaveLength(2);
});

test("part.update: a given body replaces the stored one; a bad body writes nothing", async () => {
  const { db, pid } = await setup();
  await apply(db, pid, [
    { op: "part.add", ref: "$i", kind: "interaction", title: "i", body: { text: "t", reply: "y" }, origin },
  ]);
  await apply(db, pid, [{ op: "part.update", key: "INT-001", body: { text: "x" } }]);
  expect((await loadSpec(db, pid)).parts[0]!.body).toEqual({ text: "x" });

  const err = await caught(apply(db, pid, [{ op: "part.update", key: "INT-001", body: { reply: "no text" } }]));
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).index).toBe(0);
  expect((await loadSpec(db, pid)).parts[0]!.body).toEqual({ text: "x" });
  expect(await db.select().from(changeSets)).toHaveLength(2);
});

test("undo refuses to remove a part that a later set linked, and writes nothing", async () => {
  const { db, pid } = await setup();
  const addStep = await apply(db, pid, [step("$s", "s")]);
  await apply(db, pid, [
    { op: "part.add", ref: "$w", kind: "work", title: "w", body: {}, origin },
    { op: "link.add", kind: "has_step", from: "$w", to: "STEP-001", origin },
  ]);
  const err = await caught(undoChangeSet(db, pid, addStep.changeSetId));
  expect(err).toBeInstanceOf(UndoConflict);
  expect((err as UndoConflict).parts).toEqual([{ key: "STEP-001", title: "s" }]);
  const spec = await loadSpec(db, pid);
  expect(spec.parts.map((p) => p.key)).toEqual(["STEP-001", "WRK-001"]);
  expect(spec.links).toHaveLength(1);
  expect(await db.select().from(changeSets)).toHaveLength(2);
});

test("undo refuses to bring back a link whose end a later set removed, and writes nothing", async () => {
  const { db, pid } = await setup();
  await apply(db, pid, [
    step("$a", "a"),
    step("$b", "b"),
    { op: "link.add", kind: "next", from: "$a", to: "$b", origin },
  ]);
  const id = (await loadSpec(db, pid)).links[0]!.id;
  const unlink = await apply(db, pid, [{ op: "link.remove", id }]);
  await apply(db, pid, [{ op: "part.remove", key: "STEP-002" }]);
  const err = await caught(undoChangeSet(db, pid, unlink.changeSetId));
  expect(err).toBeInstanceOf(UndoConflict);
  expect((err as UndoConflict).parts).toEqual([{ key: "STEP-002", title: "b" }]);
  expect((await loadSpec(db, pid)).links).toHaveLength(0);
  expect(await db.select().from(changeSets)).toHaveLength(3);
});
