// SPEC-106 V3 (REQ-105, TASK-113): the `spec.changed` push after every committed change set. The only outbound HTTP goes to a
// receiver this test starts on 127.0.0.1; CAW_NOTIFY_URL is set only inside these tests and cleared after each.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createApp } from "../../src/app";
import { changeSets, projects } from "../../src/db/schema";
import { confirmVersion } from "../../src/projects/service";
import { applyChangeSet, revisionOf, undoChangeSet } from "../../src/spec/store";
import { answerQ001, meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { BY } from "../helpers/by";
import { testDb } from "../helpers/db";
import { passingQuiz } from "../helpers/quiz";

let logged: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  delete process.env.CAW_NOTIFY_URL;
  logged = [];
  spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
});
afterEach(() => { delete process.env.CAW_NOTIFY_URL; spy.mockRestore(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
}

async function project() {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: [...meetingRoom, answerQ001] }); // before any receiver is set
  return { db, pid: p!.id, app: createApp(db) };
}
function receiver(onHit?: () => Promise<unknown>) {
  const received: { method: string; type: string | null; body: any }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => {
    received.push({ method: req.method, type: req.headers.get("content-type"), body: await req.json() });
    if (onHit) await onHit();
    return new Response(null, { status: 204 });
  } });
  process.env.CAW_NOTIFY_URL = `http://127.0.0.1:${server.port}/caw/notice`;
  return { received, stop: () => server.stop(true) };
}

test("a save → one POST spec.changed with projectId, the new revision and the set's time", async () => {
  const { db, pid } = await project();
  const rx = receiver();
  try {
    await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [{ op: "part.update", key: "STEP-004", title: "แก้" }] });
    await until(() => rx.received.length >= 1);
    const rev = await revisionOf(db, pid);
    const at = (await db.select().from(changeSets)).find((c) => c.rev === rev)!.at.toISOString();
    expect(rx.received).toEqual([{ method: "POST", type: "application/json", body: { event: "spec.changed", projectId: pid, revision: rev, at } }]);
    expect(logged).toEqual([]);
  } finally { rx.stop(); }
});

test("each saved change gets its own push with the right revision: hand edit over HTTP, then an undo", async () => {
  const { db, pid, app } = await project();
  const rx = receiver();
  try {
    const res = await app.request(`/v1/projects/${pid}/change-sets`, {
      method: "POST", headers: { ...BY, "content-type": "application/json" },
      body: JSON.stringify({ cause: { kind: "operator" }, changes: [{ op: "part.update", key: "STEP-004", title: "ผ่าน HTTP" }] }),
    });
    expect(res.status).toBe(201);
    const { changeSetId } = (await res.json()) as { changeSetId: string };
    await until(() => rx.received.length >= 1);
    await undoChangeSet(db, pid, changeSetId, "โด่ง");
    await until(() => rx.received.length >= 2);
    const base = (await revisionOf(db, pid)) - 1;
    expect(rx.received.map((r) => [r.body.event, r.body.revision])).toEqual([["spec.changed", base], ["spec.changed", base + 1]]);
  } finally { rx.stop(); }
});

test("the save does not wait for a slow receiver (sleeps 3 s; the save returns in < 1 s), and the late failure is one codes-only line", async () => {
  const { db, pid } = await project();
  const rx = receiver(() => sleep(3_000));
  try {
    const t0 = Date.now();
    await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [{ op: "part.update", key: "STEP-004", title: "ช้า" }] });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(logged).toEqual([]); // nothing has failed yet
    await until(() => logged.length >= 1, 3_500); // the 2 s limit passes
    expect(logged).toEqual(["[notify] failed reason=timeout"]);
  } finally { rx.stop(); }
});

test("a receiver that is down never fails the save: it answers, the spec is saved, one codes-only line", async () => {
  const { db, pid } = await project();
  const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = dead.port;
  dead.stop(true);
  process.env.CAW_NOTIFY_URL = `http://127.0.0.1:${port}/caw/notice`;
  const before = await revisionOf(db, pid);
  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [{ op: "part.update", key: "STEP-004", title: "ปลายทางปิด" }] });
  expect(await revisionOf(db, pid)).toBe(before + 1);
  await until(() => logged.length >= 1);
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatch(/^\[notify\] failed reason=[a-z0-9_]+$/);
});

test("no push for a refused change set, for the undoable dry run, or for a label; a label still sends version.confirmed exactly as before", async () => {
  const { db, pid, app } = await project();
  await passingQuiz(db, pid);
  const rx = receiver();
  try {
    await expect(applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [{ op: "part.update", key: "NOPE-999", title: "x" }] })).rejects.toThrow();
    // GET change set reads `undoable` through a rolled-back dry-run undo
    const first = (await db.select().from(changeSets)).sort((a, b) => a.rev - b.rev)[0]!;
    expect((await app.request(`/v1/projects/${pid}/change-sets/${first.id}`)).status).toBe(200);
    await sleep(150);
    expect(rx.received).toEqual([]);
    const label = await confirmVersion(db, pid, "โด่ง", "v1");
    expect(label.version).toBe(1);
    await until(() => rx.received.length >= 1);
    await sleep(150);
    expect(rx.received.map((r) => r.body.event)).toEqual(["version.confirmed"]);
  } finally { rx.stop(); }
});

test("env empty → a save makes no outbound call", async () => {
  const { db, pid } = await project();
  const fetchSpy = spyOn(globalThis, "fetch");
  try {
    await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [{ op: "part.update", key: "STEP-004", title: "ไม่มีปลายทาง" }] });
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(logged).toEqual([]);
  } finally { fetchSpy.mockRestore(); }
});
