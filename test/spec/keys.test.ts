import { expect, test } from "bun:test";
import { compareKeys, kindOfKey, nextKey } from "../../src/spec/keys";

test("compareKeys sorts by prefix, then number", () => {
  expect(["STEP-010", "STEP-009", "API-002", "STEP-001"].sort(compareKeys))
    .toEqual(["API-002", "STEP-001", "STEP-009", "STEP-010"]);
});

test("nextKey counts past every key ever issued", () => {
  expect(nextKey("step", ["STEP-001", "STEP-003"])).toBe("STEP-004");
  expect(nextKey("question", [])).toBe("Q-001");
  expect(nextKey("step", ["STEP-999"])).toBe("STEP-1000");
  expect(nextKey("step", ["WRK-007", "STEP-002"])).toBe("STEP-003");
});

test("kindOfKey names the kind and refuses a malformed key", () => {
  expect(kindOfKey("SCR-004")).toBe("screen");
  expect(kindOfKey("Q-012")).toBe("question");
  expect(() => kindOfKey("SCR-4")).toThrow();
  expect(() => kindOfKey("UC-001")).toThrow();
});
