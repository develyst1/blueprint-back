// REQ-103 / SPEC-104 (TASK-107): the typed name on every write, hand labels with no gate, the requirement kind,
// the project-wide history, the test-only link allow-list — and the seam left exactly as it was (AC-9).
// No live gateway: the one round runs on a stub; the one local page is served by this file on 127.0.0.1.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app";
import type { Db } from "../../src/db/client";
import { messages, versions } from "../../src/db/schema";
import { createGateway } from "../../src/gateway/client";
import { runRound } from "../../src/interview/round";
import { fetchLink, testAllowed } from "../../src/sources/link";
import { confirmVersion } from "../../src/projects/service";
import { addItem } from "../../src/quiz/store";
import { loadSpec } from "../../src/spec/store";
import type { Change } from "../../src/spec/types";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";

const NAME = "โด่ง";
const BY = encodeURIComponent(NAME);
const origin = { stamp: "operator", date: "2026-10-29" } as const;

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["SOURCES_DIR", "BLUEPRINT_LINK_TEST_ALLOW", "DATABASE_URL"]) saved[k] = process.env[k];
  const dir = mkdtempSync(join(tmpdir(), "blueprint-store-"));
  dirs.push(dir);
  process.env.SOURCES_DIR = dir; // never ./data in the repo
  process.env.DATABASE_URL = "pglite:memory";
  delete process.env.BLUEPRINT_LINK_TEST_ALLOW;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function api() {
  const db = await testDb();
  const app = createApp(db);
  // `by`: undefined = the usual name; null = no header at all; a string = that raw header value.
  const call = async (method: string, path: string, body?: unknown, by: string | null | undefined = undefined) => {
    const headers: Record<string, string> = {};
    if (by !== null) headers["x-blueprint-by"] = by === undefined ? BY : by;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { payload = JSON.stringify(body); headers["content-type"] = "application/json"; }
    const res = await app.request(path, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const project = async () => (await call("POST", "/v1/projects", { name: "จองห้องประชุม" })).body.id as string;
  const changes = (id: string, list: Change[], by?: string | null) =>
    call("POST", `/v1/projects/${id}/change-sets`, { cause: { kind: "operator" }, changes: list }, by);
  const step = (ref: string, title: string): Change => ({ op: "part.add", ref, kind: "step", title, body: {}, origin });
  const history = async (id: string) => (await call("GET", `/v1/projects/${id}/history`)).body.entries as any[];
  return { db, call, project, changes, step, history };
}

// --- who ----------------------------------------------------------------------------------------------------

test("AC-6: a write with no name is 400 name_required and writes nothing — every write route group", async () => {
  const { call, project, history } = await api();

  // projects: no row is created
  const noName = await call("POST", "/v1/projects", { name: "x" }, null);
  expect(noName.status).toBe(400);
  expect(noName.body).toEqual({ error: { code: "name_required", message: "type your name first" } });
  expect((await call("GET", "/v1/projects")).body).toEqual([]);

  const id = await project();
  const uuid = "00000000-0000-4000-8000-000000000009";
  const refused: [string, string, string, unknown][] = [
    ["PATCH", `/v1/projects/${id}`, "projects (settings)", { creativity: 1 }],
    ["POST", `/v1/projects/${id}/change-sets`, "change-sets", { cause: { kind: "operator" }, changes: [{ op: "part.add", ref: "$a", kind: "step", title: "ก", body: {}, origin }] }],
    ["POST", `/v1/projects/${id}/change-sets/${uuid}/undo`, "undo", undefined],
    ["POST", `/v1/projects/${id}/rounds`, "rounds", { message: "สวัสดี" }],
    ["POST", `/v1/projects/${id}/sources`, "sources (link)", { link: "https://example.com/a", origin }],
    ["POST", `/v1/projects/${id}/quizzes`, "quizzes", undefined],
    ["POST", `/v1/projects/${id}/versions`, "versions (label)", { label: "v1" }],
  ];
  for (const [method, path, group, body] of refused) {
    const r = await call(method, path, body, null);
    expect([group, r.status, r.body.error?.code]).toEqual([group, 400, "name_required"]);
  }
  // the sources upload (multipart) is covered by the same middleware
  const form = new FormData();
  form.append("file", new File(["hello"], "a.txt", { type: "text/plain" }));
  form.append("origin", JSON.stringify(origin));
  const up = await call("POST", `/v1/projects/${id}/sources`, form, null);
  expect([up.status, up.body.error.code]).toEqual([400, "name_required"]);

  // nothing was written by any of them
  expect(await history(id)).toHaveLength(1); // only the project_create of `project()`
  expect((await call("GET", `/v1/projects/${id}/labels`)).body).toEqual({ labels: [] });
  expect((await call("GET", `/v1/projects/${id}/sources`)).body).toEqual([]);
  expect((await call("GET", `/v1/projects/${id}/messages`)).body).toEqual([]);
  expect((await call("GET", `/v1/projects/${id}/quizzes/latest`)).status).toBe(404);
  const now = (await call("GET", `/v1/projects/${id}`)).body;
  expect(now.parts).toEqual([]);
  expect(now.project.creativity).toBe(0.5);
});

test("AC-6: a name that is empty, blank, undecodable, over 100 characters or holds a NUL is refused; 100 is fine", async () => {
  const { call } = await api();
  for (const bad of ["", "%20%20", "%E0%A4%A", "x".repeat(101), "%00", `a%00b`]) {
    const r = await call("POST", "/v1/projects", { name: "x" }, bad);
    expect([bad, r.status, r.body.error.code]).toEqual([bad, 400, "name_required"]);
  }
  expect((await call("POST", "/v1/projects", { name: "x" }, "x".repeat(100))).status).toBe(201);
  expect((await call("POST", "/v1/projects", { name: "y" }, "%20%E0%B9%82%E0%B8%94%E0%B9%88%E0%B8%87%20")).status).toBe(201); // " โด่ง " is trimmed
});

test("AC-9: the seam's locate and amendments still work with no name", async () => {
  const { call, project } = await api();
  const id = await project();
  const located = await call("POST", `/v1/projects/${id}/locate`, { request: "ห้องประชุม" }, null);
  expect([located.status, located.body.error.code]).toEqual([409, "no_confirmed_version"]); // not 400 name_required
  const amended = await call("POST", `/v1/projects/${id}/amendments`, { from: "CAW worker", request: "เพิ่มหน้าจอ" }, null);
  expect(amended.status).toBe(201);
  expect(amended.body.role).toBe("caw");
});

// --- AC-5: five records with the name ----------------------------------------------------------------------

test("AC-5: add source, re-fetch a failed link, change model, change creativity, label — five entries by โด่ง", async () => {
  const { call, project, history } = await api();
  const id = await project();

  // QA's recipe (SPEC-104 § Test-only seam): allow 127.0.0.1:<port>, add the link while nothing listens, then serve it.
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  process.env.BLUEPRINT_LINK_TEST_ALLOW = `127.0.0.1:${port}`;
  const link = `http://127.0.0.1:${port}/page`;

  const added = await call("POST", `/v1/projects/${id}/sources`, { link, origin });
  expect(added.status).toBe(201);
  expect([added.body.status, added.body.reason]).toEqual(["failed", "link_unreachable"]);

  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("<html><body><p>ห้องประชุมใหญ่ต้องอนุมัติ</p></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } }) });
  try {
    const again = await call("POST", `/v1/projects/${id}/sources`, { link, origin });
    expect([again.status, again.body.status, again.body.id]).toEqual([201, "read", added.body.id]);
  } finally { server.stop(true); }

  expect((await call("PATCH", `/v1/projects/${id}`, { model: "tier:small" })).status).toBe(200);
  expect((await call("PATCH", `/v1/projects/${id}`, { creativity: 1.2 })).status).toBe(200);
  expect((await call("POST", `/v1/projects/${id}/versions`, { label: "รอบแรก" })).status).toBe(201);

  const entries = await history(id);
  const five = entries.filter((e) => e.kind !== "project_create");
  expect(five.map((e) => e.kind)).toEqual(["label", "settings", "settings", "source_refetch", "source_add"]); // newest first
  expect(five.every((e) => e.by === NAME)).toBe(true);
  expect(entries.find((e) => e.kind === "project_create")).toMatchObject({ by: NAME, entity: "project", op: "project_create", before: null, changeSetId: null });

  const [label, creativity, model, refetch, add] = five;
  expect(label).toMatchObject({ entity: "label:1", before: null, after: { version: 1, label: "รอบแรก" } });
  expect(creativity).toMatchObject({ entity: "project", before: { model: "tier:small", creativity: 0.5 }, after: { model: "tier:small", creativity: 1.2 } });
  expect(model).toMatchObject({ before: { model: "tier:medium", creativity: 0.5 }, after: { model: "tier:small", creativity: 0.5 } });
  // the failed row is kept whole in `before`; the new text is in `after`
  expect(refetch.entity).toBe(`source:${added.body.id}`);
  expect(refetch.before).toMatchObject({ status: "failed", reason: "link_unreachable", text: "" });
  expect(refetch.before.storedAs).toBeString();
  expect(refetch.after).toMatchObject({ status: "read" });
  expect(refetch.after.text).toContain("ห้องประชุมใหญ่ต้องอนุมัติ");
  expect(refetch.after.sha256).not.toBe(refetch.before.sha256);
  expect(add).toMatchObject({ entity: `source:${added.body.id}`, before: null, after: { status: "failed", reason: "link_unreachable", text: "" } });
});

test("a spec change keeps its own home, with the name; undo carries the name of who undid it", async () => {
  const { call, project, changes, step, history } = await api();
  const id = await project();
  const cs = await changes(id, [step("$a", "ส่งคำขอจอง")]);
  expect(cs.status).toBe(201);
  const undone = await call("POST", `/v1/projects/${id}/change-sets/${cs.body.changeSetId}/undo`, undefined, encodeURIComponent("ฟ้า"));
  expect(undone.status).toBe(201);
  const entries = await history(id);
  const spec = entries.filter((e) => e.changeSetId !== null);
  expect(spec.map((e) => [e.kind, e.op, e.by])).toEqual([["undo", "remove", "ฟ้า"], ["operator", "add", NAME]]);
  const part = (await call("GET", `/v1/projects/${id}/parts/STEP-001/history`)).body;
  expect(part.map((e: any) => e.by)).toEqual([NAME, "ฟ้า"]); // per-part history gains `by` (oldest first)
});

// --- labels ------------------------------------------------------------------------------------------------

test("AC-7: an empty or blank label is 400 validation and saves nothing", async () => {
  const { call, project } = await api();
  const id = await project();
  for (const body of [{ label: "" }, { label: "   " }, {}, { label: "x".repeat(81) }]) {
    const r = await call("POST", `/v1/projects/${id}/versions`, body);
    expect([JSON.stringify(body).slice(0, 20), r.status, r.body.error.code]).toEqual([JSON.stringify(body).slice(0, 20), 400, "validation"]);
  }
  expect((await call("GET", `/v1/projects/${id}/labels`)).body).toEqual({ labels: [] });
  expect((await call("GET", `/v1/projects/${id}/versions?after=0`)).body.versions).toEqual([]);
  expect((await call("POST", `/v1/projects/${id}/versions`, { label: "x".repeat(80) })).status).toBe(201); // 80 is the limit
});

test("AC-1 + D2: a label is allowed with stuck items, no quiz, and even on an empty project", async () => {
  const { call, project, changes, step } = await api();
  const empty = await project();
  const first = await call("POST", `/v1/projects/${empty}/versions`, { label: "  ว่างเปล่า  " });
  expect([first.status, first.body]).toEqual([201, { version: 1, label: "ว่างเปล่า" }]); // trimmed; no change set yet

  const id = await project();
  await changes(id, [step("$a", "ส่งคำขอจอง")]); // an unlinked step → stuck
  expect((await call("GET", `/v1/projects/${id}/stuck`)).body.items.length).toBeGreaterThan(0);
  expect((await call("GET", `/v1/projects/${id}/quizzes/latest`)).status).toBe(404); // and no quiz
  const r = await call("POST", `/v1/projects/${id}/versions`, { label: "ยังไม่เสร็จ" });
  expect([r.status, r.body]).toEqual([201, { version: 1, label: "ยังไม่เสร็จ" }]);
  const labels = (await call("GET", `/v1/projects/${id}/labels`)).body.labels;
  expect(labels).toHaveLength(1);
  expect(labels[0]).toMatchObject({ version: 1, label: "ยังไม่เสร็จ", by: NAME });
  expect(labels[0].labelledAt).toBeString();
});

test("AC-2: two labels, then a part edit — still exactly 2 rows; nothing makes a label by itself", async () => {
  const { call, project, changes, step } = await api();
  const id = await project();
  await changes(id, [step("$a", "ส่งคำขอจอง")]);
  expect((await call("POST", `/v1/projects/${id}/versions`, { label: "หนึ่ง" })).body.version).toBe(1);
  expect((await call("POST", `/v1/projects/${id}/versions`, { label: "สอง" })).body.version).toBe(2); // same state, labels are tags
  await changes(id, [{ op: "part.update", key: "STEP-001", title: "ส่งคำขอจองห้อง" }]);
  const labels = (await call("GET", `/v1/projects/${id}/labels`)).body.labels;
  expect(labels.map((l: any) => [l.version, l.label])).toEqual([[2, "สอง"], [1, "หนึ่ง"]]); // newest first
  const feed = (await call("GET", `/v1/projects/${id}/versions?after=0`)).body;
  expect(feed.versions.map((v: any) => v.version)).toEqual([1, 2]);
  expect(feed.changedSinceLatest).toBe(true);
});

// --- requirements ------------------------------------------------------------------------------------------

test("AC-4: a requirement is added, edited and removed by hand — 3 history entries with the name, never stuck", async () => {
  const { call, project, changes, history } = await api();
  const id = await project();
  const add = await changes(id, [{ op: "part.add", ref: "$r", kind: "requirement", title: "อนุมัติห้องใหญ่", body: { text: "ห้องที่จุเกิน 10 คนต้องให้ผู้ดูแลอนุมัติ" }, origin }]);
  expect([add.status, add.body.keys]).toEqual([201, { $r: "REQ-001" }]);
  expect((await changes(id, [{ op: "part.update", key: "REQ-001", body: { text: "เกิน 12 คน" } }])).status).toBe(201);
  // a requirement stands alone: reading the project, and the stuck list, work with it in the spec
  const live = (await call("GET", `/v1/projects/${id}`)).body;
  expect(live.parts.map((p: any) => [p.key, p.kind, p.body])).toEqual([["REQ-001", "requirement", { text: "เกิน 12 คน" }]]);
  expect((await call("GET", `/v1/projects/${id}/stuck`)).body).toEqual({ items: [] });
  expect((await changes(id, [{ op: "part.remove", key: "REQ-001" }])).status).toBe(201);

  const mine = (await history(id)).filter((e) => e.entity === "part:REQ-001");
  expect(mine.map((e) => [e.op, e.by, e.kind])).toEqual([["remove", NAME, "operator"], ["update", NAME, "operator"], ["add", NAME, "operator"]]);
  expect((await call("GET", `/v1/projects/${id}/stuck`)).body).toEqual({ items: [] });
});

test("D7: no link may touch a requirement; a body outside the schema is refused", async () => {
  const { call, project, changes } = await api();
  const id = await project();
  await changes(id, [
    { op: "part.add", ref: "$r", kind: "requirement", title: "ข้อกำหนด", body: { text: "x" }, origin },
    { op: "part.add", ref: "$q", kind: "question", title: "ถามอะไร", body: { text: "ถามอะไร" }, origin },
  ]);
  const toReq = await changes(id, [{ op: "link.add", kind: "about", from: "Q-001", to: "REQ-001", origin }]);
  expect([toReq.status, toReq.body.error.code]).toEqual([400, "validation"]);
  expect(toReq.body.error.message).toContain("requirement stands alone");
  const extra = await changes(id, [{ op: "part.add", ref: "$x", kind: "requirement", title: "y", body: { text: "x", extra: 1 }, origin }]);
  expect(extra.status).toBe(400);
  const empty = await changes(id, [{ op: "part.add", ref: "$x", kind: "requirement", title: "y", body: { text: "" }, origin }]);
  expect(empty.status).toBe(400);
});

test("D6: the interview cannot add a requirement (a stub model proposes one and is refused)", async () => {
  const db = await testDb();
  const app = createApp(db);
  const made = await app.request("/v1/projects", { method: "POST", headers: { "x-blueprint-by": BY, "content-type": "application/json" }, body: JSON.stringify({ name: "จองห้อง" }) });
  const pid = ((await made.json()) as any).id as string;
  const proposal = JSON.stringify({
    reply: "เพิ่มข้อกำหนดให้แล้ว",
    changes: [{ change: { op: "part.add", ref: "$r", kind: "requirement", title: "ข้อกำหนด", body: { text: "ต้องอนุมัติ" } }, saidBy: "user", quote: "ห้องใหญ่ต้องอนุมัติ", sure: true }],
  });
  const gateway = createGateway({
    baseUrl: "https://gateway.example.com",
    fetch: async () => new Response(JSON.stringify({ success: true, data: { provider: "openai", model: "stub", content: proposal, usage: {}, latency_ms: 1 } })),
  });
  const round = await runRound(db, gateway, pid, { message: "ห้องใหญ่ต้องอนุมัติ ช่วยเพิ่มเป็นข้อกำหนด" }, { today: "2026-10-29", by: NAME });
  expect(round.status).toBe("changes_rejected");
  expect(round.changeSetId).toBeNull();
  expect((await loadSpec(db, pid)).parts).toEqual([]);
});

test("a round carries the name: the change set and the user's chat row, not the bot's", async () => {
  const db = await testDb();
  const app = createApp(db);
  const pid = (await (await app.request("/v1/projects", { method: "POST", headers: { "x-blueprint-by": BY, "content-type": "application/json" }, body: JSON.stringify({ name: "จองห้อง" }) })).json() as any).id as string;
  const reply = JSON.stringify({
    reply: "เพิ่มแล้ว",
    changes: [{ change: { op: "part.add", ref: "$r", kind: "role", title: "ฝ่ายบัญชี", body: {} }, saidBy: "user", quote: "ต้องมีฝ่ายบัญชี", sure: true }],
  });
  const gateway = createGateway({
    baseUrl: "https://gateway.example.com",
    fetch: async () => new Response(JSON.stringify({ success: true, data: { provider: "openai", model: "stub", content: reply, usage: {}, latency_ms: 1 } })),
  });
  const round = await runRound(db, gateway, pid, { message: "ต้องมีฝ่ายบัญชี" }, { today: "2026-10-29", by: NAME });
  expect(round.status).toBe("applied");
  const rows = await db.select().from(messages).where(eq(messages.projectId, pid));
  expect(rows.map((r) => [r.role, r.by]).sort()).toEqual([["bot", null], ["user", NAME]]);
  const history = ((await (await app.request(`/v1/projects/${pid}/history`)).json()) as any).entries as any[];
  expect(history.find((e) => e.entity === "part:ROLE-001")).toMatchObject({ by: NAME, kind: "message", op: "add" });
});

test("quiz: start, ask and mark leave quiz events with the name; a wrong mark's change set carries it too", async () => {
  const { db, call, project, history } = await api();
  const id = await project();
  const quiz = (await call("POST", `/v1/projects/${id}/quizzes`)).body;
  // `ask` needs the model, so items are stored the way the answering step hands them over (addItem writes the quiz_ask event)
  const ask = (question: string) => addItem(db, id, quiz.id, { question, status: "answered", answer: "ตอบ", notInSpec: false, parts: [], model: "stub" }, NAME);
  const one = await ask("คำถามหนึ่ง");
  const two = await ask("คำถามสอง");
  expect((await call("POST", `/v1/projects/${id}/quizzes/${quiz.id}/items/${one.id}/mark`, { mark: "right" })).status).toBe(200);
  expect((await call("POST", `/v1/projects/${id}/quizzes/${quiz.id}/items/${two.id}/mark`, { mark: "wrong", note: "ผิด" })).status).toBe(200);

  const entries = await history(id);
  const kinds = entries.map((e) => e.kind);
  for (const [kind, n] of [["quiz_start", 1], ["quiz_ask", 2], ["quiz_mark", 2]] as const) {
    expect([kind, entries.filter((e) => e.kind === kind && e.by === NAME).length]).toEqual([kind, n]);
  }
  expect(entries.find((e) => e.kind === "quiz_ask")).toMatchObject({ entity: `quiz:${quiz.id}`, before: null, after: { question: "คำถามสอง", status: "answered" } });
  expect(entries.filter((e) => e.kind === "quiz_mark").map((e) => e.after.mark).sort()).toEqual(["right", "wrong"]);
  // the wrong mark became an open question, as one change set made by the marker
  expect(entries.find((e) => e.entity === "part:Q-001")).toMatchObject({ kind: "operator", op: "add", by: NAME });
  expect(kinds).not.toContain("label");
});

// --- the test-only link seam -------------------------------------------------------------------------------

test("BLUEPRINT_LINK_TEST_ALLOW: allowed only for a listed host:port (host and port both match)", () => {
  const env = { BLUEPRINT_LINK_TEST_ALLOW: "127.0.0.1:4295, localhost:4296", DATABASE_URL: "pglite:memory" };
  expect(testAllowed(new URL("http://127.0.0.1:4295/page"), env)).toBe(true);
  expect(testAllowed(new URL("http://LOCALHOST:4296/x"), env)).toBe(true);
  expect(testAllowed(new URL("http://127.0.0.1:4296/page"), env)).toBe(false); // right host, wrong port
  expect(testAllowed(new URL("http://localhost:4295/page"), env)).toBe(false); // right port, wrong host
  expect(testAllowed(new URL("http://127.0.0.1/page"), env)).toBe(false); // default port 80 is not 4295
  expect(testAllowed(new URL("http://10.0.0.5:4295/page"), env)).toBe(false);
  expect(testAllowed(new URL("http://127.0.0.1:4295/"), { ...env, BLUEPRINT_LINK_TEST_ALLOW: "" })).toBe(false); // unset/empty = as today
  expect(testAllowed(new URL("http://127.0.0.1:4295/"), { DATABASE_URL: "pglite:memory" })).toBe(false);
});

test("BLUEPRINT_LINK_TEST_ALLOW: ignored with a real database, and said so once", () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const env = { BLUEPRINT_LINK_TEST_ALLOW: "127.0.0.1:4295", DATABASE_URL: "postgres://u:p@db.example.com/blueprint" };
    expect(testAllowed(new URL("http://127.0.0.1:4295/page"), env)).toBe(false);
    expect(testAllowed(new URL("http://127.0.0.1:4295/page"), env)).toBe(false);
    expect(testAllowed(new URL("http://127.0.0.1:4295/page"), { BLUEPRINT_LINK_TEST_ALLOW: "127.0.0.1:4295" })).toBe(false); // no DATABASE_URL at all
    expect(log.mock.calls.filter((c) => c[0] === "[link] test allow-list ignored")).toHaveLength(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("db.example.com"); // never the URL
  } finally { log.mockRestore(); }
});

test("BLUEPRINT_LINK_TEST_ALLOW: a listed address is fetched; a redirect off the list is refused; unset = refused as before", async () => {
  const page = (url: string) => url === "http://127.0.0.1:4295/page"
    ? new Response("<p>hello</p>", { headers: { "content-type": "text/html" } })
    : url === "http://127.0.0.1:4295/hop"
      ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1:4296/elsewhere" } })
      : new Response("should never be fetched", { status: 200 });
  const fetched: string[] = [];
  const deps = { lookup: async () => { throw new Error("an IP literal needs no lookup"); }, fetch: async (url: string) => { fetched.push(url); return page(url); } };

  const off = await fetchLink("http://127.0.0.1:4295/page", deps);
  expect(off).toEqual({ kind: "refused", why: "the link points at a private or local address" });
  expect(fetched).toEqual([]);

  process.env.BLUEPRINT_LINK_TEST_ALLOW = "127.0.0.1:4295";
  const ok = await fetchLink("http://127.0.0.1:4295/page", deps);
  expect(ok).toMatchObject({ kind: "fetched", outcome: { status: "read" } });

  const hopped = await fetchLink("http://127.0.0.1:4295/hop", deps);
  expect(hopped).toEqual({ kind: "refused", why: "the link points at a private or local address" });
  expect(fetched).toEqual(["http://127.0.0.1:4295/page", "http://127.0.0.1:4295/hop"]); // :4296 was never fetched
});

// --- AC-9: the seam, byte for byte for an unlabelled version ------------------------------------------------

test("AC-9: for a version with no label, getVersion and versionsAfter return exactly the keys they did before", async () => {
  const { db, call, project, changes, step } = await api();
  const id = await project();
  await changes(id, [step("$a", "ส่งคำขอจอง")]);
  await confirmVersion(db as Db, id, NAME); // a row as before labels existed: label null
  await call("POST", `/v1/projects/${id}/versions`, { label: "ติดป้าย" }); // and one with a label

  const [row] = await (db as Db).select({ label: versions.label }).from(versions).where(eq(versions.version, 1));
  expect(row!.label).toBeNull();

  for (const n of [1, 2]) {
    const v = (await call("GET", `/v1/projects/${id}/versions/${n}`)).body;
    expect(Object.keys(v).sort()).toEqual(["confirmedAt", "confirmedBy", "links", "parts", "quiz", "summary", "version"]);
  }
  const feed = (await call("GET", `/v1/projects/${id}/versions?after=0`)).body;
  expect(Object.keys(feed).sort()).toEqual(["changedSinceLatest", "latest", "versions"]);
  for (const entry of feed.versions) expect(Object.keys(entry).sort()).toEqual(["changes", "confirmedAt", "confirmedBy", "summary", "version"]);
  expect(Object.keys(feed.latest).sort()).toEqual(["confirmedAt", "version"]);
  expect((await call("GET", `/v1/projects/${id}`)).body.project).not.toHaveProperty("label");
});
