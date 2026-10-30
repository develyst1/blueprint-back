// SPEC-106 (REQ-105, TASK-113): the seam v2 reads — the revision counter, the current spec, context, locate and the changes feed.
// New file; the v1 seam tests are untouched. No gateway, no CLI; HTTP through `createApp(db).request`.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app";
import type { Db } from "../../src/db/client";
import { changeSets, projects } from "../../src/db/schema";
import { confirmVersion } from "../../src/projects/service";
import { addFile } from "../../src/sources/service";
import { addItem, markItem, startQuiz } from "../../src/quiz/store";
import { applyChangeSet, loadSpec, revisionOf, undoChangeSet } from "../../src/spec/store";
import type { Change } from "../../src/spec/types";
import { answerQ001, meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { BY } from "../helpers/by";
import { testDb } from "../helpers/db";
import { passingQuiz } from "../helpers/quiz";

const origin = { stamp: "operator", date: "2026-10-30" } as const;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function project(seed: boolean) {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  const pid = p!.id;
  if (seed) await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [...meetingRoom, answerQ001] });
  const app = createApp(db);
  // `headers` = false sends no name header at all (the v2 reads need none).
  const call = async (method: string, path: string, body?: unknown, headers = true) => {
    const res = await app.request(path, {
      method, headers: { ...(headers ? BY : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { db, pid, call };
}
const edit = (key: string, title: string): Change => ({ op: "part.update", key, title });

// --- the revision counter ----------------------------------------------------------------------------------------

test("revision is 0 on an empty project, and every saved spec change raises it by exactly 1 (round, hand edit, requirement, undo, wrong mark)", async () => {
  const { db, pid } = await project(false);
  expect(await revisionOf(db, pid)).toBe(0);
  const seen: number[] = [];
  const save = async (fn: () => Promise<unknown>) => { await fn(); seen.push(await revisionOf(db, pid)); };

  await save(() => applyChangeSet(db, pid, { cause: meetingRoomCause, changes: meetingRoom }));                     // hand edit (operator)
  await save(() => applyChangeSet(db, pid, { cause: { kind: "message", ref: "m1" }, changes: [edit("STEP-004", "รอบแชท")] })); // an interview round
  await save(() => applyChangeSet(db, pid, { cause: { kind: "source", ref: "s1" }, changes: [edit("STEP-004", "จากเอกสาร")] })); // a source
  await save(() => applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [{ op: "part.add", ref: "$r", kind: "requirement", title: "ข้อกำหนด", body: { text: "ต้องอนุมัติ" }, origin }] })); // requirement
  const last = await db.select().from(changeSets);
  const lastSet = last.sort((a, b) => a.rev - b.rev).at(-1)!;
  await save(() => undoChangeSet(db, pid, lastSet.id, "โด่ง"));                                                      // undo
  // a wrong quiz mark writes a question part through a change set
  const quiz = await startQuiz(db, pid);
  const item = await addItem(db, pid, quiz.id, { question: "ถามอะไร", status: "answered", answer: "ตอบ", notInSpec: false, parts: [], model: "openai/gpt-4.1-mini" });
  await save(() => markItem(db, pid, quiz.id, item.id, { mark: "wrong" }, { today: "2026-10-30" }));
  expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
});

test("sources, labels and a 'right' mark do NOT raise the revision", async () => {
  const { db, pid } = await project(true);
  const before = await revisionOf(db, pid);
  const dir = mkdtempSync(join(tmpdir(), "blueprint-spec-v2-")); dirs.push(dir);
  await addFile(db, dir, pid, { name: "notes.txt", bytes: new TextEncoder().encode("เอกสาร"), origin });
  expect(await revisionOf(db, pid)).toBe(before);
  await passingQuiz(db, pid); // 5 'right' marks
  await confirmVersion(db, pid, "โด่ง", "v1");
  expect(await revisionOf(db, pid)).toBe(before);
});

test("concurrent saves on one project get distinct, consecutive revisions", async () => {
  const { db, pid } = await project(true);
  const before = await revisionOf(db, pid);
  await Promise.all([1, 2, 3, 4, 5].map((n) => applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [edit("STEP-004", `พร้อมกัน ${n}`)] })));
  const revs = (await db.select({ rev: changeSets.rev }).from(changeSets)).map((r) => r.rev).sort((a, b) => a - b);
  expect(revs.slice(-5)).toEqual([before + 1, before + 2, before + 3, before + 4, before + 5]);
  expect(await revisionOf(db, pid)).toBe(before + 5);
});

test("a refused change set takes no revision", async () => {
  const { db, pid } = await project(true);
  const before = await revisionOf(db, pid);
  await expect(applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [edit("NOPE-999", "x")] })).rejects.toThrow();
  expect(await revisionOf(db, pid)).toBe(before);
});

// --- GET …/spec ----------------------------------------------------------------------------------------------------

test("GET /spec: projectId, revision, savedAt, latestLabel (null), parts and links as in GET /v1/projects/{id}", async () => {
  const { db, pid, call } = await project(true);
  const spec = await loadSpec(db, pid);
  const r = await call("GET", `/v1/projects/${pid}/spec`, undefined, false); // no name header
  expect(r.status).toBe(200);
  expect(Object.keys(r.body).sort()).toEqual(["latestLabel", "links", "parts", "projectId", "revision", "savedAt"]);
  expect(r.body.projectId).toBe(pid);
  expect(r.body.revision).toBe(await revisionOf(db, pid));
  expect(r.body.savedAt).toBe((await db.select().from(changeSets)).find((c) => c.rev === r.body.revision)!.at.toISOString());
  expect(r.body.latestLabel).toBeNull();
  const project1 = await call("GET", `/v1/projects/${pid}`);
  expect(r.body.parts).toEqual(project1.body.parts);
  expect(r.body.links).toEqual(project1.body.links);
  expect(r.body.parts.length).toBe(spec.parts.length);
});

test("GET /spec on an empty project: revision 0, savedAt null, no parts; an unknown project → 404 not_found", async () => {
  const { pid, call } = await project(false);
  const r = await call("GET", `/v1/projects/${pid}/spec`);
  expect([r.status, r.body.revision, r.body.savedAt, r.body.parts, r.body.links]).toEqual([200, 0, null, [], []]);
  const missing = await call("GET", "/v1/projects/00000000-0000-0000-0000-000000000099/spec");
  expect([missing.status, missing.body.error.code]).toEqual([404, "not_found"]);
});

test("GET /spec carries latestLabel once a label is put, with the revision unchanged", async () => {
  const { db, pid, call } = await project(true);
  await passingQuiz(db, pid);
  await confirmVersion(db, pid, "โด่ง", "v1 หลังแก้");
  const r = await call("GET", `/v1/projects/${pid}/spec`);
  expect(r.body.latestLabel).toEqual({ version: 1, label: "v1 หลังแก้", labelledAt: expect.any(String), by: "โด่ง" });
  expect(r.body.revision).toBe(await revisionOf(db, pid));
});

test("GET /spec shows an edit made after a label: the spec is live, not the labelled snapshot", async () => {
  const { db, pid, call } = await project(true);
  await passingQuiz(db, pid);
  await confirmVersion(db, pid, "โด่ง", "v1");
  const labelled = (await call("GET", `/v1/projects/${pid}/spec`)).body;
  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [edit("STEP-004", "หลังติดป้าย")] });
  const now = (await call("GET", `/v1/projects/${pid}/spec`)).body;
  expect(now.revision).toBe(labelled.revision + 1);
  expect(now.parts.find((p: any) => p.key === "STEP-004").title).toBe("หลังติดป้าย");
  expect(now.latestLabel.version).toBe(1);
});

// --- GET …/spec/parts/{key}/context --------------------------------------------------------------------------------

test("GET /spec/parts/{key}/context: v1's body with revision, savedAt, latestLabel instead of version/confirmedAt; unknown key → 404", async () => {
  const { db, pid, call } = await project(true);
  const r = await call("GET", `/v1/projects/${pid}/spec/parts/STEP-004/context`, undefined, false);
  expect(r.status).toBe(200);
  expect(Object.keys(r.body).sort()).toEqual(["decisions", "flows", "latestLabel", "neighbours", "part", "projectId", "questions", "relatedDecisions", "relatedDecisionsMore", "revision", "savedAt"]);
  expect(r.body.part.key).toBe("STEP-004");
  expect(r.body.revision).toBe(await revisionOf(db, pid));
  expect(r.body.neighbours.length).toBeGreaterThan(0);
  expect(r.body).not.toHaveProperty("version");
  expect(r.body).not.toHaveProperty("confirmedAt");
  // the same body the versioned route gives for the same state
  await passingQuiz(db, pid);
  await confirmVersion(db, pid, "โด่ง", "v1");
  const v1 = (await call("GET", `/v1/projects/${pid}/versions/1/parts/STEP-004/context`)).body;
  const v2 = (await call("GET", `/v1/projects/${pid}/spec/parts/STEP-004/context`)).body;
  for (const f of ["part", "neighbours", "decisions", "flows", "questions"]) expect(v2[f]).toEqual(v1[f]);
  const gone = await call("GET", `/v1/projects/${pid}/spec/parts/NOPE-999/context`);
  expect([gone.status, gone.body.error.code]).toEqual([404, "not_found"]);
});

// --- POST …/spec/locate --------------------------------------------------------------------------------------------

test("POST /spec/locate with NO label at all → candidates from the live spec, no name header needed (v1 locate refuses: 409)", async () => {
  const { db, pid, call } = await project(true);
  const v1 = await call("POST", `/v1/projects/${pid}/locate`, { request: "อนุมัติห้องใหญ่" });
  expect([v1.status, v1.body.error.code]).toEqual([409, "no_confirmed_version"]);
  const r = await call("POST", `/v1/projects/${pid}/spec/locate`, { request: "อนุมัติห้องใหญ่" }, false);
  expect(r.status).toBe(200);
  expect(Object.keys(r.body).sort()).toEqual(["candidates", "notInSpec", "revision"]);
  expect(r.body.revision).toBe(await revisionOf(db, pid));
  expect(r.body.notInSpec).toBe(false);
  expect(r.body.candidates.map((c: any) => c.key)).toContain("STEP-004");
  expect(Object.keys(r.body.candidates[0]).sort()).toEqual(["key", "kind", "matched", "score", "title", "where"]);
});

test("POST /spec/locate on an empty spec → notInSpec true, no candidates; a request that matches nothing too; empty request → 400", async () => {
  const { pid, call } = await project(false);
  const empty = await call("POST", `/v1/projects/${pid}/spec/locate`, { request: "อนุมัติห้องใหญ่" });
  expect([empty.status, empty.body.revision, empty.body.notInSpec, empty.body.candidates]).toEqual([200, 0, true, []]);
  const bad = await call("POST", `/v1/projects/${pid}/spec/locate`, { request: "" });
  expect([bad.status, bad.body.error.code]).toEqual([400, "validation"]);
});

test("POST /spec/locate sees a part that was added after the last label", async () => {
  const { db, pid, call } = await project(true);
  await passingQuiz(db, pid);
  await confirmVersion(db, pid, "โด่ง", "v1");
  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [{ op: "part.add", ref: "$n", kind: "role", title: "ผู้ตรวจสอบพิเศษคนใหม่", body: {}, origin }, edit("STEP-004", "ผู้ตรวจสอบพิเศษคนใหม่ตรวจคำขอ")] });
  const r = await call("POST", `/v1/projects/${pid}/spec/locate`, { request: "ผู้ตรวจสอบพิเศษคนใหม่ตรวจคำขอ" });
  expect(r.body.candidates.map((c: any) => c.title)).toContain("ผู้ตรวจสอบพิเศษคนใหม่ตรวจคำขอ");
});

// --- GET …/spec/changes ------------------------------------------------------------------------------------------

test("GET /spec/changes: one entry per set with rev > after, ascending; fields rev, at, by, cause, added, changed, removed", async () => {
  const { db, pid, call } = await project(true);
  const base = await revisionOf(db, pid);
  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [edit("STEP-004", "แก้หนึ่ง")] }, { by: "โด่ง" });
  await applyChangeSet(db, pid, { cause: { kind: "message", ref: "m" }, changes: [edit("STEP-004", "แก้สอง")] });
  const r = await call("GET", `/v1/projects/${pid}/spec/changes?after=${base}`, undefined, false);
  expect(r.status).toBe(200);
  expect(Object.keys(r.body).sort()).toEqual(["changes", "latestLabel", "more", "revision"]);
  expect([r.body.revision, r.body.more, r.body.latestLabel]).toEqual([base + 2, false, null]);
  expect(r.body.changes.map((c: any) => c.rev)).toEqual([base + 1, base + 2]);
  expect(r.body.changes[0]).toEqual({ rev: base + 1, at: expect.any(String), by: "โด่ง", cause: "operator", added: [], changed: ["STEP-004"], removed: [] });
  expect(r.body.changes[1]).toMatchObject({ by: null, cause: "message" });
});

test("GET /spec/changes: after ≥ revision → []; default after is 0 (everything); a negative or non-integer after → 400 validation", async () => {
  const { db, pid, call } = await project(true);
  const rev = await revisionOf(db, pid);
  expect((await call("GET", `/v1/projects/${pid}/spec/changes?after=${rev}`)).body.changes).toEqual([]);
  expect((await call("GET", `/v1/projects/${pid}/spec/changes?after=${rev + 7}`)).body.changes).toEqual([]);
  expect((await call("GET", `/v1/projects/${pid}/spec/changes`)).body.changes.length).toBe(rev);
  for (const bad of ["-1", "1.5", "abc"]) {
    const r = await call("GET", `/v1/projects/${pid}/spec/changes?after=${bad}`);
    expect([r.status, r.body.error.code]).toEqual([400, "validation"]);
  }
  const missing = await call("GET", "/v1/projects/00000000-0000-0000-0000-000000000099/spec/changes");
  expect([missing.status, missing.body.error.code]).toEqual([404, "not_found"]);
});

test("changes feed classification: add · update · remove · restore (by undo) · a link change marks both ends changed", async () => {
  const { db, pid, call } = await project(false);
  const feed = async (after: number) => (await call("GET", `/v1/projects/${pid}/spec/changes?after=${after}`)).body.changes;
  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [
    { op: "part.add", ref: "$a", kind: "work", title: "งาน", body: {}, origin },
    { op: "part.add", ref: "$b", kind: "step", title: "ขั้น", body: {}, origin },
  ] });
  expect((await feed(0))[0]).toMatchObject({ rev: 1, added: ["STEP-001", "WRK-001"], changed: [], removed: [] });

  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [{ op: "link.add", kind: "has_step", from: "WRK-001", to: "STEP-001", origin }] });
  expect((await feed(1))[0]).toMatchObject({ rev: 2, added: [], changed: ["STEP-001", "WRK-001"], removed: [] }); // both ends

  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [edit("WRK-001", "งานใหม่")] });
  expect((await feed(2))[0]).toMatchObject({ rev: 3, added: [], changed: ["WRK-001"], removed: [] });

  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [{ op: "part.remove", key: "STEP-001" }] });
  // removing STEP-001 also drops its link, whose other end WRK-001 is therefore changed
  expect((await feed(3))[0]).toMatchObject({ rev: 4, added: [], changed: ["WRK-001"], removed: ["STEP-001"] });

  const removeSet = (await db.select().from(changeSets)).find((c) => c.rev === 4)!;
  await undoChangeSet(db, pid, removeSet.id, "โด่ง"); // restores STEP-001 and its link
  const undone = (await feed(4))[0];
  expect(undone).toMatchObject({ rev: 5, cause: "undo", by: "โด่ง", added: ["STEP-001"], removed: [] });
  expect(undone.changed).toEqual(["WRK-001"]);
});

test("changes feed: a part made and removed inside one set is in neither list", async () => {
  const { db, pid, call } = await project(true);
  const base = await revisionOf(db, pid);
  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [
    { op: "part.add", ref: "$t", kind: "role", title: "ชั่วคราว", body: {}, origin },
    edit("STEP-004", "แก้ในชุดเดียวกัน"),
    { op: "part.remove", key: "$t" },
  ] });
  const entry = (await call("GET", `/v1/projects/${pid}/spec/changes?after=${base}`)).body.changes[0];
  expect([entry.added, entry.removed, entry.changed]).toEqual([[], [], ["STEP-004"]]); // the temporary role never existed outside the set
});

test("changes feed paging: 500 sets per answer, then more=true, and asking again from the last rev finishes", async () => {
  const { db, pid, call } = await project(false);
  // 503 sets, written straight to the tables (a change set per row is too slow through applyChangeSet): the feed reads change_sets/changes only
  for (let i = 1; i <= 503; i++) await db.insert(changeSets).values({ projectId: pid, causeKind: "operator", rev: i });
  const first = (await call("GET", `/v1/projects/${pid}/spec/changes?after=0`)).body;
  expect([first.changes.length, first.more, first.revision, first.changes[0].rev, first.changes[499].rev]).toEqual([500, true, 503, 1, 500]);
  const second = (await call("GET", `/v1/projects/${pid}/spec/changes?after=500`)).body;
  expect([second.changes.map((c: any) => c.rev), second.more]).toEqual([[501, 502, 503], false]);
});
