import { expect, test } from "bun:test";
import type { Db } from "../../src/db/client";
import { versions } from "../../src/db/schema";
import {
  confirmVersion, createProject, getProject, getVersion, listProjects,
} from "../../src/projects/service";
import { ConfirmBlocked, NotFound, NothingToConfirm, ValidationError } from "../../src/spec/errors";
import { applyChangeSet } from "../../src/spec/store";
import type { Change } from "../../src/spec/types";
import { answerQ001, meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";

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

test("AC-11: a confirmed version is frozen; later edits make a new version", async () => {
  const db = await testDb();
  const { project, apply } = await withExample(db);
  await apply([answerQ001]);
  expect(await confirmVersion(db, project.id, "operator")).toEqual({ version: 1 });

  await apply([{ op: "part.update", key: "STEP-001", title: "ค้นหาห้องที่ว่าง" }]);
  const v1 = await getVersion(db, project.id, 1);
  expect(v1.parts.find((p) => p.key === "STEP-001")!.title).toBe("ค้นหาห้องว่าง");
  expect(v1.confirmedBy).toBe("operator");
  expect(v1.summary.parts).toBe(v1.parts.length);
  expect(v1.summary.links).toBe(v1.links.length);
  expect(v1.summary.partsByKind.step).toBe(6);
  expect(v1.summary.partsByKind.interaction).toBe(14);

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
