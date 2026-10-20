// The model's context for one round: the system prompt and the spec block (TASK-C-044: goal and duty).
import { expect, test } from "bun:test";
import { CAPS, SYSTEM_PROMPT, specBlock } from "../../src/interview/context";
import type { Part } from "../../src/spec/types";

const origin = { stamp: "operator", date: "2026-10-20" } as const;
const part = (key: string, kind: string, title: string, body: Record<string, unknown> = {}): Part =>
  ({ key, kind, title, body, origin, createdIn: "00000000-0000-0000-0000-000000000001" }) as unknown as Part;

test("specBlock: a work with a goal prints ` goal: \"…\"` after its title; one without prints as it always did", () => {
  const out = specBlock([part("WRK-001", "work", "จองห้อง", { goal: "ผู้ใช้อยากจองห้องประชุมเองโดยไม่ต้องโทรหาใคร" }), part("WRK-002", "work", "ยกเลิก")], []);
  expect(out).toContain('WRK-001 work "จองห้อง" goal: "ผู้ใช้อยากจองห้องประชุมเองโดยไม่ต้องโทรหาใคร"');
  expect(out.split("\n").find((l) => l.startsWith("WRK-002"))).toBe('WRK-002 work "ยกเลิก"');
});

test("specBlock: a role with a duty prints ` duty: \"…\"`; one without prints as today", () => {
  const out = specBlock([part("ROLE-001", "role", "ผู้ดูแล", { duty: "อนุมัติการจองห้องใหญ่" }), part("ROLE-002", "role", "พนักงาน")], []);
  expect(out).toContain('ROLE-001 role "ผู้ดูแล" duty: "อนุมัติการจองห้องใหญ่"');
  expect(out.split("\n").find((l) => l.startsWith("ROLE-002"))).toBe('ROLE-002 role "พนักงาน"');
});

test("specBlock: other kinds are untouched even if their body has a field named goal or duty", () => {
  const out = specBlock([part("STEP-001", "step", "เลือกห้อง", { goal: "x", duty: "y" })], []);
  expect(out).toBe('STEP-001 step "เลือกห้อง"');
});

test("specBlock: the goals stay inside the existing cap (the block is never longer than CAPS.spec)", () => {
  const many = Array.from({ length: 80 }, (_, i) => part(`WRK-${String(i + 1).padStart(3, "0")}`, "work", `งาน ${i + 1}`, { goal: "ก".repeat(600) }));
  expect(specBlock(many, []).length).toBeLessThanOrEqual(CAPS.spec);
});

test("SYSTEM_PROMPT: the new line about body.goal and body.duty is there once, in Thai, with the limits", () => {
  expect(SYSTEM_PROMPT.split("body.goal").length - 1).toBe(1);
  expect(SYSTEM_PROMPT.split("body.duty").length - 1).toBe(1);
  const line = SYSTEM_PROMPT.split("\n").find((l) => l.includes("body.goal"))!;
  expect(line).toContain("body.duty");
  expect(line).toContain("part.update");
  expect(line).toContain("400");
  expect(line).toContain("120");
});
