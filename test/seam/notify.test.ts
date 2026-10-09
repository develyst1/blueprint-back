// SPEC-A-005 § S2.5: the push notice after a confirm. The only outbound HTTP here goes to a receiver this test starts
// on 127.0.0.1 (TASK-A-029); CAW_NOTIFY_URL is set only inside these tests and cleared after each.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createApp } from "../../src/app";
import { projects } from "../../src/db/schema";
import { applyChangeSet } from "../../src/spec/store";
import { answerQ001, meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
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

// v1 confirmed with no receiver configured; then an edit and a passing quiz, so v2 is ready to confirm.
async function readyForV2() {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  const pid = p!.id;
  const app = createApp(db);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [...meetingRoom, answerQ001] });
  await passingQuiz(db, pid);
  expect((await call("POST", `/v1/projects/${pid}/versions`, { confirmedBy: "operator" })).status).toBe(201);
  await applyChangeSet(db, pid, { cause: meetingRoomCause, changes: [{ op: "part.update", key: "STEP-004", title: "ผู้ดูแลพิจารณาคำขอ" }] });
  await passingQuiz(db, pid);
  return { pid, call };
}

test("AC-7: a receiver on 127.0.0.1 gets exactly one POST for the confirm of v2", async () => {
  const { pid, call } = await readyForV2();
  const received: { method: string; type: string | null; body: unknown }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => {
    received.push({ method: req.method, type: req.headers.get("content-type"), body: await req.json() });
    return new Response(null, { status: 204 });
  } });
  try {
    process.env.CAW_NOTIFY_URL = `http://127.0.0.1:${server.port}/caw/notice`;
    const confirmed = await call("POST", `/v1/projects/${pid}/versions`, { confirmedBy: "operator" });
    expect([confirmed.status, confirmed.body]).toEqual([201, { version: 2 }]); // the confirm response does not change
    const v2 = await call("GET", `/v1/projects/${pid}/versions/2`);
    expect(received).toEqual([{ method: "POST", type: "application/json",
      body: { event: "version.confirmed", projectId: pid, version: 2, confirmedAt: v2.body.confirmedAt } }]);
    expect(logged).toEqual([]);
  } finally {
    server.stop(true);
  }
});

test("AC-6: the receiver is down — the confirm still answers 201, one codes-only line, the pull feed lists v2", async () => {
  const { pid, call } = await readyForV2();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = server.port;
  server.stop(true); // the port is closed now
  process.env.CAW_NOTIFY_URL = `http://127.0.0.1:${port}/caw/notice`;
  const confirmed = await call("POST", `/v1/projects/${pid}/versions`, { confirmedBy: "operator" });
  expect([confirmed.status, confirmed.body]).toEqual([201, { version: 2 }]);
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatch(/^\[notify\] failed reason=[a-z0-9_]+$/);
  console.log(`AC-6 log line: ${logged[0]}`);
  const feed = await call("GET", `/v1/projects/${pid}/versions?after=1`);
  expect(feed.body.versions.map((v: { version: number }) => v.version)).toEqual([2]);
});

test("a receiver answering 500 is one failed line, not a retry", async () => {
  const { pid, call } = await readyForV2();
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits++; return new Response("no", { status: 500 }); } });
  try {
    process.env.CAW_NOTIFY_URL = `http://127.0.0.1:${server.port}/`;
    expect((await call("POST", `/v1/projects/${pid}/versions`, { confirmedBy: "operator" })).status).toBe(201);
    expect([hits, logged]).toEqual([1, ["[notify] failed reason=http_500"]]);
  } finally {
    server.stop(true);
  }
});

test("env empty → a confirm makes no outbound call", async () => {
  const { pid, call } = await readyForV2();
  const fetchSpy = spyOn(globalThis, "fetch");
  try {
    expect((await call("POST", `/v1/projects/${pid}/versions`, { confirmedBy: "operator" })).status).toBe(201);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("a URL that is not http(s) is ignored — no call, one log line", async () => {
  const { pid, call } = await readyForV2();
  process.env.CAW_NOTIFY_URL = "ftp://127.0.0.1/notice";
  const fetchSpy = spyOn(globalThis, "fetch");
  try {
    expect((await call("POST", `/v1/projects/${pid}/versions`, { confirmedBy: "operator" })).status).toBe(201);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(logged).toEqual(["[notify] ignored reason=not_http"]);
  } finally {
    fetchSpy.mockRestore();
  }
});
