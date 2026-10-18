import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { isGeneratedId } from "../src/record/record-id.js";
import { generateRunId } from "../src/run/run-id.js";

// Responsibility: unit tests for the run id format — mirrors
// tests/step-record.test.ts's own
// `describe("generateStepRecordId", ...)` for the same id family.

describe("generateRunId", () => {
  it("matches run-<YYYYMMDD-HHMMSS>-<4 alphanumeric>", () => {
    const id = generateRunId(new Date("2026-08-01T14:30:22"));
    expect(id).toMatch(/^run-\d{8}-\d{6}-[a-z0-9]{4}$/);
    expect(id.startsWith("run-20260801-143022-")).toBe(true);
  });

  it("produces different ids on successive calls", () => {
    const a = generateRunId();
    const b = generateRunId();
    expect(a).not.toBe(b);
  });
});

describe("isGeneratedId", () => {
  it("accepts every run id generateRunId draws", () =>
    hegel.test((tc) => {
      const ms = tc.draw(gs.integers({ minValue: 0, maxValue: 4102444800000 }));
      expect(isGeneratedId("run", generateRunId(new Date(ms)))).toBe(true);
    }));

  it("accepts no value that is not one path segment of that shape", () =>
    hegel.test((tc) => {
      const prefix = tc.draw(gs.sampledFrom(["", "../", "../../", "/", "a/"] as const));
      const suffix = tc.draw(gs.sampledFrom(["", "/x", "/..", "\\x", "\n"] as const));
      const id = `${prefix}${generateRunId()}${suffix}`;
      expect(isGeneratedId("run", id)).toBe(prefix === "" && suffix === "");
    }));

  it("refuses the values a forged run.json has used", () => {
    expect(["../../x", "run-1", ".", "", "run-20260801-143022-ab/c", "step-20260801-143022-abcd"].map((id) => isGeneratedId("run", id))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
