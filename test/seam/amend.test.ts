// SPEC-A-005 § S2.4: an amendment from CAW lands in the chat as one `caw` message — the spec is not touched (AC-5).
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app";
import { changeSets, projects } from "../../src/db/schema";
import { applyChangeSet, loadSpec } from "../../src/spec/store";
import { meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";

async function api() {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: meetingRoom });
  const app = createApp(db);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { db, pid: p!.id, call };
}
const changeSetCount = async (db: Awaited<ReturnType<typeof testDb>>, pid: string) =>
  (await db.select().from(changeSets).where(eq(changeSets.projectId, pid))).length;

test("AC-5: an amendment is one caw message; the spec and its change sets are unchanged", async () => {
  const { db, pid, call } = await api();
  const before = await loadSpec(db, pid);
  const sets = await changeSetCount(db, pid);
  const request = "ขอเพิ่มการแจ้งเตือนทางอีเมลเมื่อผู้ดูแลอนุมัติ";
  const res = await call("POST", `/v1/projects/${pid}/amendments`, { from: "card-17", request, about: ["STEP-004", "DEC-001"] });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ role: "caw", model: "caw", creativity: 0, roundStatus: null, changeSetId: null });
  expect(res.body.content).toBe(`[CAW card-17] about: STEP-004, DEC-001\n${request}`);
  expect(await loadSpec(db, pid)).toEqual(before);
  expect(await changeSetCount(db, pid)).toBe(sets);
  const listed = await call("GET", `/v1/projects/${pid}/messages`);
  expect(listed.body.map((m: { id: string; role: string }) => [m.id, m.role])).toEqual([[res.body.id, "caw"]]);

  const bare = await call("POST", `/v1/projects/${pid}/amendments`, { from: "card-18", request: "ขอเปลี่ยนชื่อหน้าค้นหา" });
  expect([bare.status, bare.body.content]).toEqual([201, "[CAW card-18]\nขอเปลี่ยนชื่อหน้าค้นหา"]);
});

test("amendment: bad bodies and unknown about keys → 400; unknown project → 404", async () => {
  const { db, pid, call } = await api();
  const ok = { from: "card-17", request: "ขอเพิ่มการแจ้งเตือน" };
  const bad: unknown[] = [
    {}, { ...ok, from: "" }, { ...ok, from: "x".repeat(101) }, { ...ok, request: "" }, { ...ok, request: "x".repeat(4_001) },
    { ...ok, request: "a\u0000b" }, { ...ok, from: "a\u0000b" },
    { ...ok, about: Array.from({ length: 21 }, (_, i) => `STEP-${String(i + 1).padStart(3, "0")}`) },
    { ...ok, about: ["STEP-999"] }, { ...ok, about: ["nonsense"] },
  ];
  for (const body of bad) expect([JSON.stringify(body).slice(0, 40), (await call("POST", `/v1/projects/${pid}/amendments`, body)).status]).toEqual([JSON.stringify(body).slice(0, 40), 400]);
  expect((await call("GET", `/v1/projects/${pid}/messages`)).body).toEqual([]);
  expect((await call("POST", "/v1/projects/00000000-0000-4000-8000-000000000099/amendments", ok)).status).toBe(404);
  expect(await changeSetCount(db, pid)).toBe(1);
});
