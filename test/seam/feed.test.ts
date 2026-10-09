// SPEC-A-005 § S1.3 + the seam routes: the change feed (computed on read), and the HTTP surface of S1.
import { expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { projects } from "../../src/db/schema";
import { confirmVersion } from "../../src/projects/service";
import { diff, versionFeed } from "../../src/seam/feed";
import { addItem, markItem, startQuiz } from "../../src/quiz/store";
import { applyChangeSet, undoChangeSet } from "../../src/spec/store";
import { answerQ001, meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";
import { passingQuiz } from "../helpers/quiz";

// v1 = the worked example; then STEP-004 renamed; v2.
async function twoVersions() {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: [...meetingRoom, answerQ001] });
  await passingQuiz(db, p!.id);
  await confirmVersion(db, p!.id, "operator");
  await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: [{ op: "part.update", key: "STEP-004", title: "ผู้ดูแลพิจารณาคำขอ" }] });
  await passingQuiz(db, p!.id);
  await confirmVersion(db, p!.id, "operator");
  return { db, pid: p!.id };
}

test("feed: after=0 → v1 and v2 ascending; v2 changed = the edited key; after=1 → v2 only", async () => {
  const { db, pid } = await twoVersions();
  const all = await versionFeed(db, pid, 0);
  expect(all.versions.map((v) => v.version)).toEqual([1, 2]);
  expect(all.versions[0]!.changes.added).toContain("STEP-004");
  expect([all.versions[0]!.changes.changed, all.versions[0]!.changes.removed]).toEqual([[], []]);
  expect(all.versions[1]!.changes).toEqual({ added: [], changed: ["STEP-004"], removed: [] });
  expect(all.versions[1]).toMatchObject({ confirmedBy: "operator", summary: expect.any(Object), confirmedAt: expect.any(String) });
  expect((await versionFeed(db, pid, 1)).versions.map((v) => v.version)).toEqual([2]);
  expect((await versionFeed(db, pid, 2)).versions).toEqual([]);
});

test("diff: a link added, removed or relabelled marks both live ends changed; added/removed parts stay in their lists", () => {
  const origin = { stamp: "operator", date: "2026-10-09" } as const;
  const part = (key: string) => ({ key, kind: "step" as const, title: key, body: {}, origin, createdIn: "cs" });
  const link = (id: string, from: string, to: string, label: string | null) =>
    ({ id, kind: "next" as const, fromKey: from, toKey: to, position: 1, label, origin });
  const before = { parts: [part("STEP-001"), part("STEP-002"), part("STEP-003")], links: [link("a", "STEP-001", "STEP-002", "x"), link("b", "STEP-002", "STEP-003", null)] };
  const after = { parts: [part("STEP-001"), part("STEP-002"), part("STEP-004")], links: [link("a", "STEP-001", "STEP-002", "y"), link("c", "STEP-002", "STEP-004", null)] };
  expect(diff(before, after)).toEqual({ added: ["STEP-004"], changed: ["STEP-001", "STEP-002"], removed: ["STEP-003"] });
  expect(diff(after, after)).toEqual({ added: [], changed: [], removed: [] });
});

async function api() {
  const { db, pid } = await twoVersions();
  const app = createApp(db);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { call, pid, db };
}

test("HTTP: context, locate and feed answer; bad input 400; unknown 404; no version 409 no_confirmed_version", async () => {
  const { call, pid, db } = await api();
  const ctx = await call("GET", `/v1/projects/${pid}/versions/1/parts/STEP-004/context`);
  expect([ctx.status, ctx.body.part.title, ctx.body.flows[0].at]).toEqual([200, "ผู้ดูแลพิจารณา", ["STEP-004"]]);
  const found = await call("POST", `/v1/projects/${pid}/locate`, { request: "อนุมัติห้องใหญ่" });
  expect([found.status, found.body.version, found.body.notInSpec]).toEqual([200, 2, false]);
  const feed = await call("GET", `/v1/projects/${pid}/versions?after=1`);
  expect([feed.status, feed.body.versions.map((v: { version: number }) => v.version)]).toEqual([200, [2]]);
  expect([feed.body.latest.version, feed.body.changedSinceLatest]).toEqual([2, false]);
  expect((await call("GET", `/v1/projects/${pid}/versions`)).body.versions).toHaveLength(2); // after defaults to 0

  for (const after of ["-1", "x", "1.5"]) expect((await call("GET", `/v1/projects/${pid}/versions?after=${after}`)).status).toBe(400);
  for (const body of [{}, { request: "" }, { request: "x".repeat(1_001) }]) {
    expect((await call("POST", `/v1/projects/${pid}/locate`, body)).status).toBe(400);
  }

  const none = "00000000-0000-4000-8000-000000000099";
  expect((await call("GET", `/v1/projects/${none}/versions/1/parts/STEP-004/context`)).status).toBe(404);
  expect((await call("GET", `/v1/projects/${pid}/versions/99/parts/STEP-004/context`)).status).toBe(404);
  expect((await call("GET", `/v1/projects/${pid}/versions/1/parts/STEP-999/context`)).status).toBe(404);
  expect((await call("POST", `/v1/projects/${none}/locate`, { request: "ห้อง" })).status).toBe(404);
  expect((await call("GET", `/v1/projects/${none}/versions`)).status).toBe(404);

  const [fresh] = await db.insert(projects).values({ name: "ว่าง" }).returning();
  const early = await call("POST", `/v1/projects/${fresh!.id}/locate`, { request: "ห้อง" });
  expect([early.status, early.body.error.code]).toEqual([409, "no_confirmed_version"]);
  expect((await call("GET", `/v1/projects/${fresh!.id}/versions`)).body).toEqual({ versions: [], latest: null, changedSinceLatest: false });
});

test("A-032: latest + changedSinceLatest — none, v1, an edit, its undo, v2, a quiz wrong mark", async () => {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  const pid = p!.id;
  const top = async () => { const { latest, changedSinceLatest } = await versionFeed(db, pid, 0); return { latest, changedSinceLatest }; };

  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [...meetingRoom, answerQ001] });
  expect(await top()).toEqual({ latest: null, changedSinceLatest: false }); // no version yet
  await passingQuiz(db, pid);
  await confirmVersion(db, pid, "operator");
  const v1 = await top();
  expect([v1.latest?.version, typeof v1.latest?.confirmedAt, v1.changedSinceLatest]).toEqual([1, "string", false]);

  const edit = await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [{ op: "part.update", key: "STEP-004", title: "ผู้ดูแลพิจารณาคำขอ" }] });
  expect((await top()).changedSinceLatest).toBe(true);
  await undoChangeSet(db, pid, edit.changeSetId);
  expect((await top()).changedSinceLatest).toBe(true); // an undo is a change set too

  await passingQuiz(db, pid);
  await confirmVersion(db, pid, "operator");
  expect(await top()).toMatchObject({ latest: { version: 2 }, changedSinceLatest: false });

  const quiz = await startQuiz(db, pid);
  const item = await addItem(db, pid, quiz.id, { question: "ห้องใหญ่ต้องให้ใครอนุมัติ", status: "answered", answer: "ไม่มีใคร",
    notInSpec: false, parts: [], model: "openai/gpt-4.1-mini" });
  await markItem(db, pid, quiz.id, item.id, { mark: "wrong", note: "ผิด ต้องเป็นผู้ดูแลห้อง" }, { today: "2026-10-09" });
  expect((await top()).changedSinceLatest).toBe(true); // a wrong mark opens a question: the spec changed
  // `latest` does not depend on `after`
  expect((await versionFeed(db, pid, 2))).toMatchObject({ versions: [], latest: { version: 2 }, changedSinceLatest: true });
});
