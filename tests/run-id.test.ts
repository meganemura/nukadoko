import { describe, expect, it } from "vitest";
import { generateRunId } from "../src/run/run-id.js";

// Responsibility: unit tests for the run id format (m4a-run-provenance task
// spec, decision 1) — mirrors tests/step-record.test.ts's own
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
