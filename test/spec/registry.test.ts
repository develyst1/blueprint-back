import { expect, test } from "bun:test";
import { checkLink, PART_KINDS, type PartKind } from "../../src/spec/registry";
import { Change, Origin, Part } from "../../src/spec/types";

const validBodies: Record<PartKind, unknown> = {
  work: { goal: "จองห้องได้เอง" },
  step: { ends: true },
  interaction: { text: "กดยืนยันการจอง", reply: "201" },
  role: {},
  screen: { fields: [{ name: "date", label: "วันที่" }], actions: [{ name: "search" }], states: [{ name: "empty" }] },
  api: { method: "POST", path: "/bookings", responses: [{ status: 201 }] },
  system: {},
  data: { fields: [{ name: "roomId", type: "uuid" }] },
  decision: { rule: "ห้องที่จุเกิน 10 คนต้องให้ผู้ดูแลอนุมัติ", cases: ["ห้องใหญ่ → อนุมัติ"], open: "ห้องพอดี 10 คน" },
  question: { text: "ผู้ดูแลไม่ตอบใน 24 ชม. ทำอย่างไร", proposedAnswer: "ยกเลิกอัตโนมัติ" },
};

for (const kind of Object.keys(PART_KINDS) as PartKind[]) {
  test(`${kind}: a valid body parses, an extra field fails`, () => {
    const body = PART_KINDS[kind].body;
    expect(body.safeParse(validBodies[kind]).success).toBe(true);
    expect(body.safeParse({ ...(validBodies[kind] as object), extra: 1 }).success).toBe(false);
  });
}

test("body defaults are filled in", () => {
  expect(PART_KINDS.step.body.parse({})).toEqual({ ends: false });
  expect(PART_KINDS.question.body.parse({ text: "x" })).toEqual({ text: "x", status: "open" });
});

test("Origin: channel and note rules, unknown stamp", () => {
  expect(Origin.safeParse({ stamp: "operator", date: "2026-10-08" }).success).toBe(true);
  expect(Origin.safeParse({ stamp: "customer-validated", date: "2026-10-08" }).success).toBe(false);
  expect(Origin.safeParse({ stamp: "customer-validated", date: "2026-10-08", channel: "LINE" }).success).toBe(true);
  expect(Origin.safeParse({ stamp: "operator-delegated", date: "2026-10-08" }).success).toBe(false);
  expect(Origin.safeParse({ stamp: "operator-delegated", date: "2026-10-08", note: "do what you recommend" }).success).toBe(true);
  expect(Origin.safeParse({ stamp: "owner", date: "2026-10-08" }).success).toBe(false);
  expect(Origin.safeParse({ stamp: "operator", date: "8 Oct 2026" }).success).toBe(false);
});

test("link rules: labels, positions and ends come from the registry", () => {
  expect(checkLink({ kind: "next", fromKind: "step", toKind: "step", position: 1, label: "อนุมัติ" })).toBeNull();
  expect(checkLink({ kind: "shows", fromKind: "screen", toKind: "data", label: "x" })).not.toBeNull();
  expect(checkLink({ kind: "shows", fromKind: "screen", toKind: "data", position: 1 })).not.toBeNull();
  expect(checkLink({ kind: "from", fromKind: "step", toKind: "role" })).not.toBeNull();
  expect(checkLink({ kind: "from", fromKind: "interaction", toKind: "data" })).not.toBeNull();
  for (const toKind of Object.keys(PART_KINDS) as PartKind[]) {
    expect(checkLink({ kind: "covers", fromKind: "decision", toKind })).toBeNull();
  }
  expect(checkLink({ kind: "depends_on", fromKind: "step", toKind: "step" })).not.toBeNull();
});

test("a Thai title in Part parses byte-identical", () => {
  const title = "เปลี่ยนแพ็กเกจหลัก / แพ็กเกจเสริม";
  const part = Part.parse({
    key: "WRK-001", kind: "work", title, body: {}, origin: { stamp: "operator", date: "2026-10-08" },
    createdIn: "00000000-0000-0000-0000-000000000009",
  });
  expect(Buffer.from(part.title).equals(Buffer.from(title))).toBe(true);
});

test("Change: the six ops, and part.add refs look like $name", () => {
  const origin = { stamp: "operator", date: "2026-10-08" };
  expect(Change.safeParse({ op: "part.add", ref: "$a", kind: "step", title: "x", body: {}, origin }).success).toBe(true);
  expect(Change.safeParse({ op: "part.add", ref: "a", kind: "step", title: "x", body: {}, origin }).success).toBe(false);
  expect(Change.safeParse({ op: "part.update", key: "STEP-001", title: "y" }).success).toBe(true);
  expect(Change.safeParse({ op: "part.remove", key: "STEP-001" }).success).toBe(true);
  expect(Change.safeParse({ op: "link.add", kind: "next", from: "$a", to: "STEP-002", label: "ok", origin }).success).toBe(true);
  expect(Change.safeParse({ op: "link.update", id: "00000000-0000-0000-0000-000000000009", position: 2 }).success).toBe(true);
  expect(Change.safeParse({ op: "link.remove", id: "00000000-0000-0000-0000-000000000009" }).success).toBe(true);
  expect(Change.safeParse({ op: "part.rename", key: "STEP-001" }).success).toBe(false);
});
