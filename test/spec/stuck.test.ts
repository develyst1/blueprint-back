import { expect, test } from "bun:test";
import { projects } from "../../src/db/schema";
import { sequence } from "../../src/spec/diagrams";
import { computeStuck } from "../../src/spec/stuck";
import { applyChangeSet, loadSpec } from "../../src/spec/store";
import type { Change, Link, Part } from "../../src/spec/types";
import { answerQ001, meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";

const operator = { stamp: "operator", date: "2026-10-08" } as const;
const guess = { stamp: "team-proposed", date: "2026-10-08" } as const;

async function example() {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: meetingRoom });
  const apply = (changes: Change[]) => applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes });
  const stuck = async () => computeStuck(await loadSpec(db, p!.id));
  return { db, pid: p!.id, apply, stuck };
}

test("the worked example is stuck only on its open question", async () => {
  const { stuck } = await example();
  expect(await stuck()).toEqual([{ kind: "open_question", key: "Q-001", title: "ผู้ดูแลไม่ตอบใน 24 ชม. ทำอย่างไร" }]);
});

test("AC-5: answering Q-001 leaves nothing stuck", async () => {
  const { apply, stuck } = await example();
  await apply([answerQ001]);
  expect(await stuck()).toEqual([]);
});

test("AC-4: an unlinked part and a dead end show up, and nothing else", async () => {
  const { apply, stuck } = await example();
  await apply([
    { op: "part.add", ref: "$r", kind: "role", title: "ฝ่ายบัญชี", body: {}, origin: operator },
    { op: "part.update", key: "STEP-006", body: { ends: false } },
  ]);
  expect((await stuck()).map(({ kind, key, reason }) => ({ kind, key, reason }))).toEqual([
    { kind: "open_question", key: "Q-001", reason: undefined },
    { kind: "unlinked_part", key: "ROLE-003", reason: undefined },
    { kind: "flow_break", key: "STEP-006", reason: "dead_end" },
  ]);
});

// Hand-built specs for the other flow breaks — computeStuck is pure.
const p = (key: string, kind: Part["kind"], body: Record<string, unknown> = {}): Part =>
  ({ key, kind, title: key, body, origin: operator, createdIn: "cs" });
let n = 0;
const l = (kind: Link["kind"], fromKey: string, toKey: string, position: number | null = null, label: string | null = null): Link =>
  ({ id: `l${++n}`, kind, fromKey, toKey, position, label, origin: operator });
const flowBreaks = (parts: Part[], links: Link[]) =>
  computeStuck({ parts, links }).filter((i) => i.kind === "flow_break").map((i) => `${i.key} ${i.reason}`);

test("flow breaks: unreachable, unlabelled branch, no interactions", () => {
  const withInteractions = (steps: string[]) => steps.flatMap((s, i) => {
    const int = `INT-00${i + 1}`;
    return { parts: [p(int, "interaction", { text: "x" }), p(`ROLE-00${i + 1}`, "role"), p(`SCR-00${i + 1}`, "screen")],
      links: [l("has_interaction", s, int, 1), l("from", int, `ROLE-00${i + 1}`), l("to", int, `SCR-00${i + 1}`)] };
  });
  const build = (steps: string[], next: Link[], interactions = true) => {
    const extra = interactions ? withInteractions(steps) : [];
    return flowBreaks(
      [p("WRK-001", "work"), ...steps.map((s, i) => p(s, "step", { ends: i === steps.length - 1 })), ...extra.flatMap((e) => e.parts)],
      [...steps.map((s, i) => l("has_step", "WRK-001", s, i + 1)), ...next, ...extra.flatMap((e) => e.links)],
    );
  };
  // STEP-002 has no way in from step 01.
  expect(build(["STEP-001", "STEP-002", "STEP-003"], [l("next", "STEP-001", "STEP-003", 1)]))
    .toEqual(["STEP-002 unreachable", "STEP-002 dead_end"]);
  // Two ways out of STEP-001, one without a condition.
  expect(build(["STEP-001", "STEP-002", "STEP-003"], [
    l("next", "STEP-001", "STEP-002", 1, "ใช่"), l("next", "STEP-001", "STEP-003", 2), l("next", "STEP-002", "STEP-003", 1),
  ])).toEqual(["STEP-001 unlabelled_branch"]);
  // Nothing to draw in a lane or a sequence.
  expect(build(["STEP-001", "STEP-002"], [l("next", "STEP-001", "STEP-002", 1)], false))
    .toEqual(["STEP-001 no_interactions", "STEP-002 no_interactions"]);
});

test("AC-15: team-proposed parts and links are unconfirmed until re-stamped", async () => {
  const { apply, stuck, db, pid } = await example();
  await apply([
    { op: "part.add", ref: "$d", kind: "data", title: "Invoice", body: {}, origin: guess },
    { op: "link.add", kind: "shows", from: "SCR-001", to: "$d", origin: guess },
  ]);
  const linkId = (await loadSpec(db, pid)).links.find((x) => x.toKey === "DATA-003")!.id;
  expect((await stuck()).filter((i) => i.kind === "unconfirmed_guess")).toEqual([
    { kind: "unconfirmed_guess", key: "DATA-003", title: "Invoice" },
    { kind: "unconfirmed_guess", key: "SCR-001", title: "หน้าค้นหาห้อง", linkId },
  ]);
  await apply([
    { op: "part.update", key: "DATA-003", origin: operator },
    { op: "link.remove", id: linkId },
    { op: "link.add", kind: "shows", from: "SCR-001", to: "DATA-003", origin: operator },
  ]);
  expect((await stuck()).filter((i) => i.kind === "unconfirmed_guess")).toEqual([]);
});

test("AC-16: a screen showing data with no interaction to an api", async () => {
  const { apply, stuck } = await example();
  await apply([
    { op: "part.add", ref: "$s", kind: "screen", title: "หน้ารายงาน", body: {}, origin: operator },
    { op: "link.add", kind: "shows", from: "$s", to: "DATA-002", origin: operator },
    { op: "part.add", ref: "$i", kind: "interaction", title: "เปิดรายงาน", body: { text: "เปิดรายงาน" }, origin: operator },
    { op: "link.add", kind: "from", from: "$i", to: "ROLE-001", origin: operator },
    { op: "link.add", kind: "to", from: "$i", to: "$s", origin: operator },
  ]);
  expect((await stuck()).filter((i) => i.kind === "screen_without_api"))
    .toEqual([{ kind: "screen_without_api", key: "SCR-004", title: "หน้ารายงาน" }]);
  await apply([
    { op: "part.add", ref: "$j", kind: "interaction", title: "ขอข้อมูลรายงาน", body: { text: "ขอข้อมูลรายงาน" }, origin: operator },
    { op: "link.add", kind: "from", from: "$j", to: "SCR-004", origin: operator },
    { op: "link.add", kind: "to", from: "$j", to: "API-001", origin: operator },
  ]);
  expect((await stuck()).filter((i) => i.kind === "screen_without_api")).toEqual([]);
});

test("an interaction missing an end makes its step stuck, and is still drawn", async () => {
  const { apply, stuck, db, pid } = await example();
  const toLink = (await loadSpec(db, pid)).links.find((x) => x.kind === "to" && x.fromKey === "INT-008")!;
  await apply([{ op: "link.remove", id: toLink.id }]);
  expect((await stuck()).map(({ kind, key, reason }) => ({ kind, key, reason }))).toEqual([
    { kind: "open_question", key: "Q-001", reason: undefined },
    { kind: "flow_break", key: "STEP-003", reason: "incomplete_interaction" },
  ]);
  const d = sequence(await loadSpec(db, pid), "STEP-003");
  expect(d.messages).toHaveLength(4);
  expect(d.messages[2]).toMatchObject({ key: "INT-008", from: "API-002", to: null });
});

test("REQ-003 R1: an open contradiction is stuck once, naming what it is between; resolved → gone", async () => {
  const { apply, stuck } = await example();
  await apply([
    { op: "part.add", ref: "$c", kind: "contradiction", title: "ต้องอนุมัติหรือไม่", body: { note: "เอกสารขัดกับ DEC-001" }, origin: guess },
    { op: "link.add", kind: "conflicts", from: "$c", to: "STEP-003", origin: guess },
    { op: "link.add", kind: "conflicts", from: "$c", to: "DEC-001", origin: guess },
  ]);
  expect((await stuck()).map(({ kind, key, between }) => ({ kind, key, between }))).toEqual([
    { kind: "open_question", key: "Q-001", between: undefined },
    { kind: "contradiction", key: "CON-001", between: ["DEC-001", "STEP-003"] },
  ]);
  await apply([{ op: "part.update", key: "CON-001", body: { note: "เอกสารขัดกับ DEC-001", status: "resolved" } }]);
  expect((await stuck()).map((i) => i.key)).toEqual(["Q-001"]);
});
