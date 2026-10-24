import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { parseRunDocument } from "../src/report/run-document-schema.js";

// Responsibility: the check a run.json passes before nuka report reads it.
// A document with every field a report reads parses; one without any of
// them is refused naming that field, never cast and read.

const VALID = {
  schema_version: 4,
  nukadoko: "0.17.0",
  command: "run",
  verdict: "passed",
  findings: [],
  run_id: "run-20261018-000000-abcd",
  started_at: "2026-10-18T00:00:00.000Z",
  finished_at: "2026-10-18T00:00:01.000Z",
  commit: null,
  environments: [{ name: "default", target_version: null }],
  selection: "full",
  counts: { scenarios: 1, passed: 1, failed: 0, controls: 0, not_run: 0 },
  scenarios: [
    {
      scenario_record_id: "scn-1",
      feature: "features/a.feature",
      line: 3,
      scenario: "a",
      environment: "default",
      status: "passed",
      started_at: "2026-10-18T00:00:00.000Z",
      finished_at: "2026-10-18T00:00:01.000Z",
      steps: [{ line: 4, text: "a step", step: "a", status: "passed", step_record_id: "s1", record: "steps/s1" }],
      hooks: [],
    },
  ],
  table: {
    base: null,
    mapping_changed: null,
    worlds: [{ world: "head", environment: "default" }],
    rows: [
      {
        feature: "features/a.feature",
        line: 3,
        name: "a",
        change: null,
        conditions: [],
        cells: [{ world: "head", environment: "default", role: "required", outcome: "pass", runs: 1 }],
        verdict: "held",
        reason: "passes in default",
      },
    ],
  },
};

const REQUIRED = Object.keys(VALID).filter((key) => key !== "schema_version");

describe("parseRunDocument", () => {
  it("reads a document with every field a report reads", () => {
    expect(parseRunDocument(JSON.stringify(VALID))).toEqual({ document: VALID });
  });

  it("refuses a document without any one field a report reads, naming that field", () =>
    hegel.test((tc) => {
      const key = tc.draw(gs.sampledFrom(REQUIRED));
      const { [key]: _removed, ...rest } = VALID as Record<string, unknown>;
      const result = parseRunDocument(JSON.stringify(rest));
      expect("problem" in result && result.problem.startsWith("does not have the fields nuka report reads: ")).toBe(true);
      expect("problem" in result && result.problem.includes(`${key}: `)).toBe(true);
    }));

  it("refuses another schema version before it reads a field", () => {
    expect(parseRunDocument(JSON.stringify({ schema_version: 2 }))).toEqual({ problem: "has schema_version 2, and this release reads 4" });
    expect(parseRunDocument("[")).toEqual({ problem: "does not parse as JSON: Unexpected end of JSON input" });
  });
});
