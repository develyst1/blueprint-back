import { beforeAll, expect, test } from "bun:test";
import { projects } from "../../src/db/schema";
import { flowchart, sequence, swimlane } from "../../src/spec/diagrams";
import { NotFound, ValidationError } from "../../src/spec/errors";
import { applyChangeSet, loadSpec } from "../../src/spec/store";
import { meetingRoom, meetingRoomCause } from "../fixtures/meeting-room";
import { testDb } from "../helpers/db";

let spec: Awaited<ReturnType<typeof loadSpec>>;

beforeAll(async () => {
  const db = await testDb();
  const [p] = await db.insert(projects).values({ name: "จองห้องประชุม" }).returning();
  await applyChangeSet(db, p!.id, { cause: meetingRoomCause, changes: meetingRoom });
  spec = await loadSpec(db, p!.id);
});

test("AC-3: sequence of STEP-003, drawn from its interactions", () => {
  const d = sequence(spec, "STEP-003");
  expect(d.messages).toEqual([
    { key: "INT-006", from: "ROLE-001", to: "SCR-002", text: "กดยืนยันการจอง", reply: null },
    { key: "INT-007", from: "SCR-002", to: "API-002", text: "ส่ง Booking", reply: null },
    { key: "INT-008", from: "API-002", to: "SYS-001", text: "ตรวจเวลาว่างและบันทึก", reply: null },
    { key: "INT-009", from: "API-002", to: "SCR-002", text: "201 · status pending | confirmed", reply: null },
  ]);
  expect(d.participants).toEqual([
    { key: "ROLE-001", kind: "role", title: "พนักงาน" },
    { key: "SCR-002", kind: "screen", title: "หน้ายืนยันการจอง" },
    { key: "API-002", kind: "api", title: "สร้างการจอง" },
    { key: "SYS-001", kind: "system", title: "ระบบปฏิทิน" },
  ]);
});

test("AC-3: swimlane of WRK-001 matches the SPEC's table", () => {
  const d = swimlane(spec, "WRK-001");
  // The ● cells of SPEC-A-001's swimlane table, per step.
  expect(d.rows.map((r) => [r.step.key, r.step.position, r.lanes])).toEqual([
    ["STEP-001", 1, ["ROLE-001", "SCR-001", "API-001", "SYS-001"]],
    ["STEP-002", 2, ["ROLE-001", "SCR-001", "SCR-002"]],
    ["STEP-003", 3, ["ROLE-001", "SCR-002", "API-002", "SYS-001"]],
    ["STEP-004", 4, ["ROLE-002", "SCR-003", "API-003", "SYS-001"]],
    ["STEP-005", 5, ["SCR-002", "ROLE-001"]],
    ["STEP-006", 6, ["SCR-002", "ROLE-001"]],
  ]);
  expect(d.lanes.map((x) => x.key)).toEqual(
    ["ROLE-001", "SCR-001", "API-001", "SYS-001", "SCR-002", "API-002", "ROLE-002", "SCR-003", "API-003"],
  );
});

test("AC-3: flowchart of WRK-001 — branches, ends and labelled arrows", () => {
  const d = flowchart(spec, "WRK-001");
  expect(d.nodes.map((n) => [n.key, n.position, n.ends, n.isBranch])).toEqual([
    ["STEP-001", 1, false, false],
    ["STEP-002", 2, false, false],
    ["STEP-003", 3, false, true],
    ["STEP-004", 4, false, true],
    ["STEP-005", 5, true, false],
    ["STEP-006", 6, true, false],
  ]);
  expect(d.arrows).toEqual([
    { from: "STEP-001", to: "STEP-002", label: null },
    { from: "STEP-002", to: "STEP-003", label: null },
    { from: "STEP-003", to: "STEP-004", label: "ห้องใหญ่ ต้องอนุมัติ" },
    { from: "STEP-003", to: "STEP-005", label: "ห้องเล็ก ไม่ต้องอนุมัติ" },
    { from: "STEP-004", to: "STEP-005", label: "อนุมัติ" },
    { from: "STEP-004", to: "STEP-006", label: "ปฏิเสธ" },
  ]);
});

test("a key of the wrong kind is a ValidationError; an unknown key is NotFound", () => {
  expect(() => sequence(spec, "WRK-001")).toThrow(ValidationError);
  expect(() => swimlane(spec, "STEP-001")).toThrow(ValidationError);
  expect(() => flowchart(spec, "STEP-001")).toThrow(ValidationError);
  expect(() => sequence(spec, "STEP-099")).toThrow(NotFound);
  expect(() => flowchart(spec, "nonsense")).toThrow(NotFound);
});
