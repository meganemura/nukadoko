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
  counts: { scenarios: 1, passed: 1, failed: 0, not_run: 0, controls: 0, controls_not_run: 0 },
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
    mapping_changes: null,
    worlds: [{ world: "head", environment: "default" }],
    rows: [
      {
        feature: "features/a.feature",
        line: 3,
        name: "a",
        change: null,
        conditions: [],
        cells: [{ world: "head", environment: "default", role: "required", conditions: {}, outcome: "pass", runs: 1 }],
        verdict: "held",
        reason: "passes in default",
      },
    ],
    left_out: 0,
    proof_runs: 2,
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

  it("refuses a fail, broke, stopped, or flaky cell with no line, which the summary would print as @undefined", () =>
    hegel.test((tc) => {
      const outcome = tc.draw(gs.sampledFrom(["fail", "broke", "stopped", "flaky"]));
      const cell = { world: "head", environment: "default", role: "required", conditions: {}, outcome, runs: 1 };
      const document = { ...VALID, table: { ...VALID.table, rows: [{ ...VALID.table.rows[0], cells: [cell] }] } };
      const result = parseRunDocument(JSON.stringify(document));
      expect("problem" in result && result.problem).toContain("table.rows.0.cells.0.line: a fail, broke, stopped, or flaky cell names the line it stopped at");
      const fail = outcome === "fail" ? { claim: 0, actuals: [{ value: 503 }] } : {};
      expect(parseRunDocument(JSON.stringify({ ...document, table: { ...document.table, rows: [{ ...document.table.rows[0], cells: [{ ...cell, line: 4, ...fail }] }] } }))).toHaveProperty("document");
    }));

  it("refuses a stopped scenario that does not name the step it was stopped after, and reads one that does", () => {
    const entry = { ...VALID.scenarios[0], status: "stopped" };
    const without = parseRunDocument(JSON.stringify({ ...VALID, scenarios: [entry] }));
    expect("problem" in without && without.problem).toContain("scenarios.0.stopped: a stopped scenario names the step it was stopped after");
    const named = parseRunDocument(JSON.stringify({ ...VALID, scenarios: [{ ...entry, stopped: { after_step: 1, line: 4 } }] }));
    expect(named).toHaveProperty("document");
  });

  it("refuses a fail cell without the claim that broke or a value for each run, and any other cell with them", () =>
    hegel.test((tc) => {
      const outcome = tc.draw(gs.sampledFrom(["pass", "fail", "broke", "flaky", "not-run"]));
      const runs = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
      const claim = tc.draw(gs.booleans());
      const values = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
      const cell = {
        world: "head",
        environment: "default",
        role: "control",
        conditions: {},
        outcome,
        ...(outcome === "pass" || outcome === "not-run" ? {} : { line: 4 }),
        runs,
        ...(claim ? { claim: 0, actuals: Array.from({ length: values }, (_, index) => ({ value: index })) } : {}),
      };
      const document = { ...VALID, table: { ...VALID.table, rows: [{ ...VALID.table.rows[0], cells: [cell] }] } };
      const result = parseRunDocument(JSON.stringify(document));
      const valid = outcome === "fail" ? claim && values === runs : !claim;
      expect("document" in result).toBe(valid);
      if (!valid) expect("problem" in result && result.problem).toContain("a fail cell, and only a fail cell, names the claim that broke");
    }));

  it("reads the flags a summary counts, and refuses a row without any one field it reads", () =>
    hegel.test((tc) => {
      const row = {
        name: "quick_reorder",
        side: "on",
        criteria: [{ feature: "features/a.feature", line: 3, name: "a", verdict: "held", cells: [{ environment: "default", role: "required", outcome: "pass", gates: ["boolean", null] }] }],
        counts: { held: 1, proven: 0, failed: 0, unproven: 0, moved: 0, controls: 0 },
      };
      expect(parseRunDocument(JSON.stringify({ ...VALID, flags: [row] }))).toEqual({ document: { ...VALID, flags: [row] } });
      const path = tc.draw(gs.sampledFrom(["name", "side", "criteria", "counts", ...Object.keys(row.counts).map((key) => `counts.${key}`), "criteria.0.cells", "criteria.0.cells.0.gates"]));
      const broken = structuredClone(row) as Record<string, unknown>;
      const segments = path.split(".");
      let parent = broken;
      for (const segment of segments.slice(0, -1)) parent = parent[segment] as Record<string, unknown>;
      delete parent[segments[segments.length - 1]!];
      const result = parseRunDocument(JSON.stringify({ ...VALID, flags: [broken] }));
      expect("problem" in result && result.problem).toContain(`flags.0.${path}: `);
    }));

  it("refuses another schema version before it reads a field", () => {
    expect(parseRunDocument(JSON.stringify({ schema_version: 2 }))).toEqual({ problem: "has schema_version 2, and this release reads 4" });
    expect(parseRunDocument("[")).toEqual({ problem: "does not parse as JSON: Unexpected end of JSON input" });
  });
});
