import { expect, test } from "bun:test";
import type { Db } from "../../src/db/client";
import { versions } from "../../src/db/schema";
import {
  confirmVersion, createProject, getProject, getVersion, listProjects,
} from "../../src/projects/service";
import { AlreadyConfirmed, ConfirmBlocked, NotFound, NothingToConfirm, QuizNot100, ValidationError } from "../../src/spec/errors";
import { applyChangeSet, loadSpec, undoChangeSet } from "../../src/spec/store";
import { computeStuck } from "../../src/spec/stuck";
import type { Change } from "../../src/spec/types";
import { answerQ001, meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";
import { passingQuiz } from "../helpers/quiz";
import { startQuiz } from "../../src/quiz/store";

async function caught(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error("expected a rejection");
}

async function withExample(db: Db) {
  const project = await createProject(db, { name: "จองห้องประชุม" });
  const apply = (changes: Change[]) => applyChangeSet(db, project.id, { cause: meetingRoomCause, changes });
  await apply(meetingRoom);
  return { project, apply };
}

test("AC-12: a project without an organisation gets the default one", async () => {
  const db = await testDb();
  const project = await createProject(db, { name: "  จองห้องประชุม  " });
  expect(project.organisationId).toBe("00000000-0000-0000-0000-000000000001");
  expect(project.name).toBe("จองห้องประชุม");
  expect((await getProject(db, project.id)).project).toEqual(project);
});

test("unknown organisation is NotFound; a blank name is a ValidationError", async () => {
  const db = await testDb();
  expect(await caught(createProject(db, { name: "x", organisationId: "00000000-0000-0000-0000-000000000099" })))
    .toBeInstanceOf(NotFound);
  expect(await caught(createProject(db, { name: "x", organisationId: "not-a-uuid" }))).toBeInstanceOf(NotFound);
  const blank = await caught(createProject(db, { name: "   " }));
  expect(blank).toBeInstanceOf(ValidationError);
  expect((blank as ValidationError).index).toBeNull();
  expect(await listProjects(db)).toEqual([]);
});

test("AC-10: confirm is refused while something is stuck, and writes no version", async () => {
  const db = await testDb();
  const { project } = await withExample(db);
  const err = await caught(confirmVersion(db, project.id, "operator"));
  expect(err).toBeInstanceOf(ConfirmBlocked);
  expect((err as ConfirmBlocked).items).toEqual([
    { kind: "open_question", key: "Q-001", title: "ผู้ดูแลไม่ตอบใน 24 ชม. ทำอย่างไร" },
  ]);
  expect(await db.select().from(versions)).toHaveLength(0);
});

test("an empty project has nothing to confirm", async () => {
  const db = await testDb();
  const project = await createProject(db, { name: "ว่าง" });
  expect(await caught(confirmVersion(db, project.id, "operator"))).toBeInstanceOf(NothingToConfirm);
  expect(await caught(confirmVersion(db, "00000000-0000-0000-0000-000000000099", "operator"))).toBeInstanceOf(NotFound);
  expect(await db.select().from(versions)).toHaveLength(0);
});

test("A-050 (D-030): confirming an unchanged spec again → AlreadyConfirmed { version }, nothing written; a change (edit or undo) re-opens it", async () => {
  const db = await testDb();
  const { project, apply } = await withExample(db);
  await apply([answerQ001]);
  await passingQuiz(db, project.id);
  expect(await confirmVersion(db, project.id, "operator")).toEqual({ version: 1 });

  const again = await caught(confirmVersion(db, project.id, "operator"));
  expect(again).toBeInstanceOf(AlreadyConfirmed);
  expect((again as AlreadyConfirmed).version).toBe(1);
  expect(await db.select().from(versions)).toHaveLength(1);

  // order: refused before any quiz code — a fresh, empty quiz would otherwise be quiz_not_100
  await startQuiz(db, project.id);
  expect(await caught(confirmVersion(db, project.id, "operator"))).toBeInstanceOf(AlreadyConfirmed);

  // an edit, then a fresh 100 % quiz → v2
  const edit = await apply([{ op: "part.update", key: "STEP-001", title: "ค้นหาห้องที่ว่าง" }]);
  expect(await caught(confirmVersion(db, project.id, "operator"))).toBeInstanceOf(QuizNot100); // not refused as unchanged
  await passingQuiz(db, project.id);
  expect(await confirmVersion(db, project.id, "operator")).toEqual({ version: 2 });
  expect((await caught(confirmVersion(db, project.id, "operator")) as AlreadyConfirmed).version).toBe(2);

  // an undo is a change too: the spec reads like v1 again, but it is a new change set → v3 can confirm
  await undoChangeSet(db, project.id, edit.changeSetId);
  await passingQuiz(db, project.id);
  expect(await confirmVersion(db, project.id, "operator")).toEqual({ version: 3 });
});

test("AC-11: a confirmed version is frozen; later edits make a new version", async () => {
  const db = await testDb();
  const { project, apply } = await withExample(db);
  await apply([answerQ001]);
  await passingQuiz(db, project.id); // REQ-005 R6: confirm needs a passing quiz
  expect(await confirmVersion(db, project.id, "operator")).toEqual({ version: 1 });

  await apply([{ op: "part.update", key: "STEP-001", title: "ค้นหาห้องที่ว่าง" }]);
  const v1 = await getVersion(db, project.id, 1);
  expect(v1.parts.find((p) => p.key === "STEP-001")!.title).toBe("ค้นหาห้องว่าง");
  expect(v1.confirmedBy).toBe("operator");
  expect(v1.summary.parts).toBe(v1.parts.length);
  expect(v1.summary.links).toBe(v1.links.length);
  expect(v1.summary.partsByKind.step).toBe(6);
  expect(v1.summary.partsByKind.interaction).toBe(14);

  await passingQuiz(db, project.id); // the edit above made the first quiz stale
  expect(await confirmVersion(db, project.id, "operator")).toEqual({ version: 2 });
  const v2 = await getVersion(db, project.id, 2);
  expect(v2.parts.find((p) => p.key === "STEP-001")!.title).toBe("ค้นหาห้องที่ว่าง");
  expect(await caught(getVersion(db, project.id, 3))).toBeInstanceOf(NotFound);
});

test("R9: stuckCount is computed on every list", async () => {
  const db = await testDb();
  const { project, apply } = await withExample(db);
  expect((await listProjects(db)).map((p) => [p.id, p.stuckCount])).toEqual([[project.id, 1]]);
  await apply([answerQ001]);
  expect((await listProjects(db)).map((p) => [p.id, p.stuckCount])).toEqual([[project.id, 0]]);
});

test("A-041 (D-025): partCount = live parts from the same spec read; stuckCount unchanged", async () => {
  const db = await testDb();
  const empty = await createProject(db, { name: "ว่าง" });
  const { project, apply } = await withExample(db);
  const row = async (id: string) => (await listProjects(db)).find((p) => p.id === id)!;
  const truth = async (id: string) => { const spec = await loadSpec(db, id); return [spec.parts.length, computeStuck(spec).length]; };

  expect([(await row(empty.id)).partCount, (await row(empty.id)).stuckCount]).toEqual([0, 0]);
  const example = await row(project.id);
  expect([example.partCount, example.stuckCount]).toEqual(await truth(project.id));
  expect(example.partCount).toBe(34); // the worked example: 2 roles · 3 screens · 3 APIs · 1 system · 2 data · 1 work · 6 steps · 14 interactions · DEC-001 · Q-001
  await apply([{ op: "part.remove", key: "DEC-001" }]);
  const after = await row(project.id);
  expect([after.partCount, after.stuckCount]).toEqual(await truth(project.id));
  expect(after.partCount).toBe(33);
});

test("AC-B1 + AC-B2: a project keeps the theme id it was created with; none means clean-blue", async () => {
  const db = await testDb();
  const gold = await createProject(db, { name: "a", theme: "luxury-gold" });
  const plain = await createProject(db, { name: "b" });
  const neon = await createProject(db, { name: "c", theme: "neon-test" });
  expect([gold.theme, plain.theme, neon.theme]).toEqual(["luxury-gold", "clean-blue", "neon-test"]);
  const listed = new Map((await listProjects(db)).map((p) => [p.id, p.theme]));
  expect([listed.get(gold.id), listed.get(plain.id), listed.get(neon.id)]).toEqual(["luxury-gold", "clean-blue", "neon-test"]);
  expect((await getProject(db, gold.id)).project.theme).toBe("luxury-gold");

  const thai = "ธีม".repeat(21) + "ก";
  expect(thai.length).toBe(64);
  const t = await createProject(db, { name: "d", theme: thai });
  expect(Buffer.from((await getProject(db, t.id)).project.theme).equals(Buffer.from(thai))).toBe(true);

  for (const theme of ["", "   ", "a".repeat(65)]) {
    expect(await caught(createProject(db, { name: "e", theme }))).toBeInstanceOf(ValidationError);
  }
  expect(await listProjects(db)).toHaveLength(4);
});

test("REQ-003 R1: a new project carries model tier:medium and creativity 0.5", async () => {
  const db = await testDb();
  const created = await createProject(db, { name: "x" });
  expect([created.model, created.creativity]).toEqual(["tier:medium", 0.5]);
  const listed = (await listProjects(db)).find((p) => p.id === created.id)!;
  expect([listed.model, listed.creativity]).toEqual(["tier:medium", 0.5]);
  const read = (await getProject(db, created.id)).project;
  expect([read.model, read.creativity]).toEqual(["tier:medium", 0.5]);
});
