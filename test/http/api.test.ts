import { expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { flowchart, sequence, swimlane } from "../../src/spec/diagrams";
import type { Change } from "../../src/spec/types";
import { answerQ001, meetingRoom } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";

const origin = { stamp: "operator", date: "2026-10-08" };

async function api() {
  const app = createApp(await testDb());
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const project = async (name = "จองห้องประชุม") => (await call("POST", "/v1/projects", { name })).body.id as string;
  const changeSet = (id: string, changes: Change[], cause: unknown = { kind: "operator" }) =>
    call("POST", `/v1/projects/${id}/change-sets`, { cause, changes });
  return { call, project, changeSet };
}

test("AC-2 + AC-12: create a project, add a Thai step, read it back byte-identical", async () => {
  const { call, changeSet } = await api();
  const created = await call("POST", "/v1/projects", { name: "จองห้องประชุม" });
  expect(created.status).toBe(201);
  expect(created.body.organisationId).toBe("00000000-0000-0000-0000-000000000001");
  const id = created.body.id;

  const cs = await changeSet(id, [{ op: "part.add", ref: "$s", kind: "step", title: "ส่งคำขอจอง", body: {}, origin } as Change]);
  expect(cs.status).toBe(201);
  expect(cs.body.keys).toEqual({ $s: "STEP-001" });

  const got = await call("GET", `/v1/projects/${id}`);
  expect(got.status).toBe(200);
  expect(got.body.project.name).toBe("จองห้องประชุม");
  expect(Buffer.from(got.body.parts[0].title).equals(Buffer.from("ส่งคำขอจอง"))).toBe(true);
  expect(got.body.parts[0].origin).toEqual(origin);
  expect((await call("GET", "/v1/projects")).body.map((p: any) => [p.id, p.stuckCount])).toEqual([[id, 1]]);
});

test("AC-3: the three diagrams over HTTP; wrong kind of key 400, unknown key 404", async () => {
  const { call, project, changeSet } = await api();
  const id = await project();
  expect((await changeSet(id, meetingRoom)).status).toBe(201);
  const spec = (await call("GET", `/v1/projects/${id}`)).body;

  const seq = await call("GET", `/v1/projects/${id}/diagrams/sequence/STEP-003`);
  expect(seq.status).toBe(200);
  expect(seq.body).toEqual(JSON.parse(JSON.stringify(sequence(spec, "STEP-003"))));
  expect(seq.body.messages.map((m: any) => m.key)).toEqual(["INT-006", "INT-007", "INT-008", "INT-009"]);
  const lanes = await call("GET", `/v1/projects/${id}/diagrams/swimlane/WRK-001`);
  expect(lanes.body).toEqual(JSON.parse(JSON.stringify(swimlane(spec, "WRK-001"))));
  expect(lanes.body.rows).toHaveLength(6);
  const flow = await call("GET", `/v1/projects/${id}/diagrams/flowchart/WRK-001`);
  expect(flow.body).toEqual(JSON.parse(JSON.stringify(flowchart(spec, "WRK-001"))));
  expect(flow.body.arrows).toHaveLength(6);

  const wrong = await call("GET", `/v1/projects/${id}/diagrams/sequence/WRK-001`);
  expect(wrong.status).toBe(400);
  expect(wrong.body.error.code).toBe("validation");
  const unknown = await call("GET", `/v1/projects/${id}/diagrams/sequence/STEP-999`);
  expect(unknown.status).toBe(404);
  expect(unknown.body.error.code).toBe("not_found");
});

test("AC-4/5: the stuck list over HTTP empties when Q-001 is answered", async () => {
  const { call, project, changeSet } = await api();
  const id = await project();
  await changeSet(id, meetingRoom);
  const before = await call("GET", `/v1/projects/${id}/stuck`);
  expect(before.status).toBe(200);
  expect(before.body.items.map((i: any) => `${i.kind} ${i.key}`)).toEqual(["open_question Q-001"]);
  expect((await changeSet(id, [answerQ001])).status).toBe(201);
  expect((await call("GET", `/v1/projects/${id}/stuck`)).body).toEqual({ items: [] });
});

test("AC-6: part history over HTTP, with link changes; unknown part 404", async () => {
  const { call, project, changeSet } = await api();
  const id = await project();
  await changeSet(id, [
    { op: "part.add", ref: "$w", kind: "work", title: "w", body: {}, origin },
    { op: "part.add", ref: "$s", kind: "step", title: "ก", body: {}, origin },
  ] as Change[]);
  await changeSet(id, [{ op: "part.update", key: "STEP-001", title: "ข" }], { kind: "message", ref: "m1" });
  await changeSet(id, [{ op: "link.add", kind: "has_step", from: "WRK-001", to: "STEP-001", origin } as Change],
    { kind: "source", ref: "doc-1" });
  const h = await call("GET", `/v1/projects/${id}/parts/STEP-001/history`);
  expect(h.status).toBe(200);
  expect(h.body.map((e: any) => [e.op, e.cause])).toEqual([
    ["add", { kind: "operator" }],
    ["update", { kind: "message", ref: "m1" }],
    ["link_add", { kind: "source", ref: "doc-1" }],
  ]);
  const missing = await call("GET", `/v1/projects/${id}/parts/STEP-999/history`);
  expect(missing.status).toBe(404);
  expect(missing.body.error.code).toBe("not_found");
});

test("AC-7 / AC-8: remove and undo over HTTP; undo after a newer edit is 409 undo_conflict", async () => {
  const { call, project, changeSet } = await api();
  const id = await project();
  await changeSet(id, [
    { op: "part.add", ref: "$i", kind: "interaction", title: "i", body: { text: "i" }, origin },
    { op: "part.add", ref: "$s", kind: "screen", title: "s", body: {}, origin },
    { op: "part.add", ref: "$d", kind: "data", title: "d", body: {}, origin },
    { op: "link.add", kind: "from", from: "$i", to: "$s", origin },
    { op: "link.add", kind: "shows", from: "$s", to: "$d", origin },
  ] as Change[]);
  const before = (await call("GET", `/v1/projects/${id}`)).body;
  const removal = await changeSet(id, [{ op: "part.remove", key: "SCR-001" }]);
  expect((await call("GET", `/v1/projects/${id}`)).body.links).toEqual([]);
  const undo = await call("POST", `/v1/projects/${id}/change-sets/${removal.body.changeSetId}/undo`);
  expect(undo.status).toBe(201);
  expect(typeof undo.body.changeSetId).toBe("string");
  expect((await call("GET", `/v1/projects/${id}`)).body.links).toEqual(before.links);

  const a = await changeSet(id, [{ op: "part.add", ref: "$x", kind: "step", title: "ก", body: {}, origin } as Change]);
  await changeSet(id, [{ op: "part.update", key: "STEP-001", title: "ข" }]);
  const conflict = await call("POST", `/v1/projects/${id}/change-sets/${a.body.changeSetId}/undo`);
  expect(conflict.status).toBe(409);
  expect(conflict.body).toEqual({
    error: { code: "undo_conflict", message: expect.any(String), details: { parts: [{ key: "STEP-001", title: "ข" }] } },
  });
});

test("AC-9: a bad 2nd change is 400 with details.index 1 and writes nothing; an empty list is 400", async () => {
  const { call, project, changeSet } = await api();
  const id = await project();
  const bad = await changeSet(id, [
    { op: "part.add", ref: "$s", kind: "step", title: "x", body: {}, origin },
    { op: "link.add", kind: "shows", from: "$s", to: "$s", origin },
  ] as Change[]);
  expect(bad.status).toBe(400);
  expect(bad.body.error.code).toBe("validation");
  expect(bad.body.error.details.index).toBe(1);
  expect((await call("GET", `/v1/projects/${id}`)).body.parts).toEqual([]);

  const empty = await call("POST", `/v1/projects/${id}/change-sets`, { cause: { kind: "operator" }, changes: [] });
  expect(empty.status).toBe(400);
  expect(empty.body.error.code).toBe("validation");

  const malformed = await changeSet(id, [{ op: "part.add", ref: "$s", kind: "spaceship", title: "x", body: {}, origin } as any]);
  expect(malformed.status).toBe(400);
  expect(malformed.body.error.details.index).toBe(0);

  // Request faults keep the one error shape: no body, a non-JSON body, an unknown route.
  for (const init of [{ method: "POST" }, { method: "POST", body: "x", headers: { "content-type": "text/plain" } }]) {
    const res = await createApp(await testDb()).request("/v1/projects", init);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("validation");
  }
  const nowhere = await call("GET", "/v1/nowhere");
  expect(nowhere.status).toBe(404);
  expect(nowhere.body.error.code).toBe("not_found");
});

test("AC-10/11: confirm blocked while stuck; version 1 is frozen after a later edit", async () => {
  const { call, project, changeSet } = await api();
  const id = await project();
  await changeSet(id, meetingRoom);
  const blocked = await call("POST", `/v1/projects/${id}/versions`, { confirmedBy: "operator" });
  expect(blocked.status).toBe(409);
  expect(blocked.body.error.code).toBe("confirm_blocked");
  expect(blocked.body.error.details.items.map((i: any) => i.key)).toEqual(["Q-001"]);

  await changeSet(id, [answerQ001]);
  expect((await call("POST", `/v1/projects/${id}/versions`, { confirmedBy: "   " })).status).toBe(400);
  const ok = await call("POST", `/v1/projects/${id}/versions`, { confirmedBy: "operator" });
  expect(ok).toEqual({ status: 201, body: { version: 1 } });
  await changeSet(id, [{ op: "part.update", key: "STEP-001", title: "ค้นหาห้องที่ว่าง" }]);
  const v1 = await call("GET", `/v1/projects/${id}/versions/1`);
  expect(v1.status).toBe(200);
  expect(v1.body.parts.find((p: any) => p.key === "STEP-001").title).toBe("ค้นหาห้องว่าง");
  expect(v1.body.confirmedBy).toBe("operator");
  expect((await call("GET", `/v1/projects/${id}/versions/2`)).status).toBe(404);
});

test("AC-13: the OpenAPI document lists every route of the SPEC", async () => {
  const { call } = await api();
  const doc = await call("GET", "/v1/openapi.json");
  expect(doc.status).toBe(200);
  expect(doc.body.openapi).toStartWith("3.1");
  expect(doc.body.info).toMatchObject({ title: "Blueprint API", version: "1.0.0" });
  const routes: [string, string][] = [
    ["post", "/v1/projects"],
    ["get", "/v1/projects"],
    ["get", "/v1/projects/{projectId}"],
    ["post", "/v1/projects/{projectId}/change-sets"],
    ["post", "/v1/projects/{projectId}/change-sets/{changeSetId}/undo"],
    ["get", "/v1/projects/{projectId}/parts/{key}/history"],
    ["get", "/v1/projects/{projectId}/stuck"],
    ["get", "/v1/projects/{projectId}/diagrams/{kind}/{key}"],
    ["post", "/v1/projects/{projectId}/versions"],
    ["get", "/v1/projects/{projectId}/versions/{version}"],
    ["get", "/v1/openapi.json"],
  ];
  for (const [method, path] of routes) expect(doc.body.paths[path]?.[method]).toBeDefined();
});

test("limits: a body over 5 MB is 413 too_large; 5001 changes and an out-of-range position are 400", async () => {
  const { call, project, changeSet } = await api();
  const id = await project();
  const app = createApp(await testDb());
  const pid = (await (await app.request("/v1/projects", {
    method: "POST", body: JSON.stringify({ name: "x" }), headers: { "content-type": "application/json" },
  })).json() as any).id;

  // 5,000,001 bytes of valid JSON: one change whose title pads the body to size.
  const shell = JSON.stringify({ cause: { kind: "operator" }, changes: [{ op: "part.add", ref: "$s", kind: "step", title: "", body: {}, origin }] });
  const big = shell.replace('"title":""', `"title":"${"x".repeat(5_000_001 - shell.length)}"`);
  expect(Buffer.byteLength(big)).toBe(5_000_001);
  const tooLarge = await app.request(`/v1/projects/${pid}/change-sets`, {
    method: "POST", body: big, headers: { "content-type": "application/json" },
  });
  expect(tooLarge.status).toBe(413);
  expect(((await tooLarge.json()) as any).error.code).toBe("too_large");
  expect(((await (await app.request(`/v1/projects/${pid}`)).json()) as any).parts).toEqual([]);

  const many = Array.from({ length: 5001 }, (_, i) =>
    ({ op: "part.add", ref: `$s${i}`, kind: "step", title: "s", body: {}, origin }) as Change);
  const tooMany = await changeSet(id, many);
  expect(tooMany.status).toBe(400);
  expect(tooMany.body.error.code).toBe("validation");

  await changeSet(id, [
    { op: "part.add", ref: "$w", kind: "work", title: "w", body: {}, origin },
    { op: "part.add", ref: "$s", kind: "step", title: "s", body: {}, origin },
  ] as Change[]);
  for (const position of [2147483648, 0]) {
    const res = await changeSet(id, [{ op: "link.add", kind: "has_step", from: "WRK-001", to: "STEP-001", position, origin } as Change]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation");
  }
  const spec = (await call("GET", `/v1/projects/${id}`)).body;
  expect(spec.parts.map((p: any) => p.key)).toEqual(["STEP-001", "WRK-001"]);
  expect(spec.links).toEqual([]);
});

test("AC-B1…B3: theme over HTTP — kept, defaulted, and refused when empty or too long", async () => {
  const { call } = await api();
  const gold = await call("POST", "/v1/projects", { name: "a", theme: "luxury-gold" });
  expect(gold.status).toBe(201);
  expect(gold.body.theme).toBe("luxury-gold");
  const plain = await call("POST", "/v1/projects", { name: "b" });
  expect(plain.body.theme).toBe("clean-blue");
  const list = (await call("GET", "/v1/projects")).body;
  expect(new Map(list.map((p: any) => [p.id, p.theme])).get(plain.body.id)).toBe("clean-blue");
  expect((await call("GET", `/v1/projects/${plain.body.id}`)).body.project.theme).toBe("clean-blue");

  for (const theme of ["", "a".repeat(65), "   "]) {
    const bad = await call("POST", "/v1/projects", { name: "c", theme });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("validation");
  }
  expect((await call("GET", "/v1/projects")).body).toHaveLength(list.length);
});
