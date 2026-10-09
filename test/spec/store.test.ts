import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/db/client";
import { changes, changeSets, messages, parts, projects } from "../../src/db/schema";
import { NotFound, UndoConflict, ValidationError } from "../../src/spec/errors";
import { applyChangeSet, loadSpec, partHistory, readChangeSet, undoChangeSet } from "../../src/spec/store";
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

test("A-023 step 1: an inTx callback runs before commit; if it throws, nothing of the set is kept", async () => {
  const { db, pid } = await setup();
  const seen: string[] = [];
  const ok = await applyChangeSet(db, pid, { cause: operator, changes: [step("$a", "a")] }, {
    inTx: async (tx, result) => {
      seen.push(result.changeSetId);
      await tx.insert(messages).values({ projectId: pid, role: "bot", content: "ok", model: "m", creativity: 0.5, changeSetId: result.changeSetId });
    },
  });
  expect(seen).toEqual([ok.changeSetId]);
  expect(await db.select().from(messages)).toHaveLength(1);

  const sets = (await db.select().from(changeSets)).length;
  const rows = (await db.select().from(changes)).length;
  const err = await caught(applyChangeSet(db, pid, { cause: operator, changes: [step("$b", "b")] }, {
    inTx: async (tx, result) => {
      await tx.insert(messages).values({ projectId: pid, role: "bot", content: "x", model: "m", creativity: 0.5, changeSetId: result.changeSetId });
      throw new Error("bot row failed");
    },
  }));
  expect((err as Error).message).toBe("bot row failed");
  expect((await db.select().from(changeSets)).length).toBe(sets);
  expect((await db.select().from(changes)).length).toBe(rows);
  expect(await db.select().from(messages)).toHaveLength(1);
  expect((await loadSpec(db, pid)).parts.map((p) => p.key)).toEqual(["STEP-001"]);
});

test("A-030: a set adding 3 parts + 2 links and updating 1 → counts 5/1/0, undoable; then the undo works", async () => {
  const { db, pid } = await setup();
  await apply(db, pid, [step("$x", "x")]);
  const set = await apply(db, pid, [
    step("$a", "a"), step("$b", "b"), step("$c", "c"),
    { op: "link.add", kind: "next", from: "$a", to: "$b", origin },
    { op: "link.add", kind: "next", from: "$b", to: "$c", origin },
    { op: "part.update", key: "STEP-001", title: "x2" },
  ], { kind: "message", ref: "m-1" });
  const read = await readChangeSet(db, pid, set.changeSetId);
  expect(read).toMatchObject({ id: set.changeSetId, cause: { kind: "message", ref: "m-1" },
    counts: { added: 5, updated: 1, removed: 0 }, undoable: true });
  expect(typeof read.at).toBe("string");
  expect(read.entities).toHaveLength(6);
  expect(read.entities.filter((e) => e.startsWith("part:"))).toEqual(["part:STEP-002", "part:STEP-003", "part:STEP-004", "part:STEP-001"]);
  // reading changed nothing (the undoable check never keeps a write)
  expect(await db.select().from(changeSets)).toHaveLength(2);
  await undoChangeSet(db, pid, set.changeSetId);
  expect((await loadSpec(db, pid)).parts.map((p) => [p.key, p.title])).toEqual([["STEP-001", "x"]]);
  expect(await readChangeSet(db, pid, set.changeSetId)).toMatchObject({ undoable: false }); // its parts changed again (the undo)
});

test("A-030: a newer set touching one of its parts → undoable false, and the undo still refuses the same way", async () => {
  const { db, pid } = await setup();
  const a = await apply(db, pid, [step("$a", "ก")]);
  await apply(db, pid, [{ op: "part.update", key: "STEP-001", title: "ข" }]);
  expect((await readChangeSet(db, pid, a.changeSetId)).undoable).toBe(false);
  const err = await caught(undoChangeSet(db, pid, a.changeSetId));
  expect(err).toBeInstanceOf(UndoConflict);
  expect((err as UndoConflict).parts).toEqual([{ key: "STEP-001", title: "ข" }]);
});

test("A-030: undoable follows every refusal of the undo — a part a later set linked, a link whose end was removed", async () => {
  const { db, pid } = await setup();
  const addStep = await apply(db, pid, [step("$s", "s")]);
  await apply(db, pid, [
    { op: "part.add", ref: "$w", kind: "work", title: "w", body: {}, origin },
    { op: "link.add", kind: "has_step", from: "$w", to: "STEP-001", origin },
  ]);
  expect((await readChangeSet(db, pid, addStep.changeSetId)).undoable).toBe(false);
  expect(await caught(undoChangeSet(db, pid, addStep.changeSetId))).toBeInstanceOf(UndoConflict);

  const two = await setup();
  await apply(two.db, two.pid, [step("$a", "a"), step("$b", "b"), { op: "link.add", kind: "next", from: "$a", to: "$b", origin }]);
  const id = (await loadSpec(two.db, two.pid)).links[0]!.id;
  const unlink = await apply(two.db, two.pid, [{ op: "link.remove", id }]);
  expect(await readChangeSet(two.db, two.pid, unlink.changeSetId)).toMatchObject({ counts: { added: 0, updated: 0, removed: 1 }, undoable: true });
  await apply(two.db, two.pid, [{ op: "part.remove", key: "STEP-002" }]);
  expect((await readChangeSet(two.db, two.pid, unlink.changeSetId)).undoable).toBe(false);
  expect(await caught(undoChangeSet(two.db, two.pid, unlink.changeSetId))).toBeInstanceOf(UndoConflict);
});

test("A-030: an unknown set, another project's set, a bad id or an unknown project → NotFound", async () => {
  const { db, pid } = await setup();
  const other = await setup();
  const theirs = await apply(other.db, other.pid, [step("$a", "a")]);
  const [p2] = await db.insert(projects).values({ name: "y" }).returning();
  const mine = await apply(db, p2!.id, [step("$a", "a")]);
  expect(await caught(readChangeSet(db, pid, theirs.changeSetId))).toBeInstanceOf(NotFound);
  expect(await caught(readChangeSet(db, pid, mine.changeSetId))).toBeInstanceOf(NotFound); // p2's set, asked under pid
  expect(await caught(readChangeSet(db, pid, "not-a-uuid"))).toBeInstanceOf(NotFound);
  expect(await caught(readChangeSet(db, "00000000-0000-4000-8000-000000000099", mine.changeSetId))).toBeInstanceOf(NotFound);
});
