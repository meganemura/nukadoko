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

  it("reads the routes and the world lists a summary reads, and refuses an entry or a list without any one field it reads", () =>
    hegel.test((tc) => {
      const route = {
        method: "PUT",
        route: tc.draw(gs.sampledFrom(["/rooms/:id", null])),
        handlers: ["rooms#update"],
        listed_in: ["default"],
        requests: 1,
        statuses: [200],
        criteria: [{ feature: "features/a.feature", line: 3, name: "a", verdict: "held", cells: [{ environment: "default", role: "required", outcome: "pass", requests: 1, statuses: [200] }] }],
        counts: { held: 1, proven: 0, failed: 0, unproven: 0, moved: 0, controls: 0 },
      };
      const world = { name: "default", url: "http://localhost:4000", lists: { routes: { entries: 7, error: null }, flags: { entries: null, error: "it exited with code 1" } } };
      const whole = { ...VALID, worlds: [world], routes: [route] };
      expect(parseRunDocument(JSON.stringify(whole))).toEqual({ document: whole });
      const path = tc.draw(
        gs.sampledFrom(["routes.0.method", "routes.0.route", "routes.0.handlers", "routes.0.listed_in", "routes.0.requests", "routes.0.criteria", "routes.0.criteria.0.cells.0.environment", "routes.0.criteria.0.cells.0.requests", "worlds.0.lists.routes.entries", "worlds.0.lists.flags.error"]),
      );
      const broken = structuredClone(whole) as Record<string, unknown>;
      const segments = path.split(".");
      let parent = broken;
      for (const segment of segments.slice(0, -1)) parent = parent[segment] as Record<string, unknown>;
      delete parent[segments[segments.length - 1]!];
      const result = parseRunDocument(JSON.stringify(broken));
      expect("problem" in result && result.problem).toContain(path.startsWith("worlds") ? segments.slice(0, 3).join(".") : `${path}: `);
    }));

  it("reads the paths a summary lists, and refuses a comparison without any one field it reads", () =>
    hegel.test((tc) => {
      const comparison = {
        between: { kind: "condition", name: "quick_reorder", a: false, b: true },
        a: { world: "head", environment: "reorder-off" },
        b: { world: "head", environment: "reorder-on" },
        unread: null,
        counts: { changed: 1, open: 0, same_so_far: 0, marked_only: 0, same: 0, not_compared: 0 },
        criteria: [
          {
            feature: "features/a.feature",
            line: 3,
            name: "a",
            result: "changed",
            a: { scenario_record_id: "scn-1", outcome: "broke", line: 4 },
            b: { scenario_record_id: "scn-2", outcome: "pass" },
            steps: [
              {
                line: 4,
                text: "a reorder",
                ran: "both",
                changed: [{ kind: "request", method: "POST", route: "/reorders", status: 201, a: { at_least: 0, at_most: 0 }, b: { at_least: 1, at_most: 1 } }],
                open: [],
                gaps: { a: [], b: [{ gap: "jobs-pending", job_ids: ["j1"] }] },
              },
            ],
          },
        ],
        not_compared: [],
      };
      expect(parseRunDocument(JSON.stringify({ ...VALID, paths: [comparison] }))).toEqual({ document: { ...VALID, paths: [comparison] } });
      const againstBase = { ...comparison, between: { kind: "base" }, a: { world: "base", environment: "reorder-on" }, b: { world: "head", environment: "reorder-on" } };
      expect(parseRunDocument(JSON.stringify({ ...VALID, paths: [againstBase] }))).toEqual({ document: { ...VALID, paths: [againstBase] } });
      const path = tc.draw(
        gs.sampledFrom([
          "between",
          "between.name",
          "a.environment",
          "unread",
          "counts.open",
          "counts.same_so_far",
          "criteria",
          "criteria.0.result",
          "criteria.0.a.line",
          "criteria.0.steps.0.changed.0.route",
          "criteria.0.steps.0.changed.0.b",
          "criteria.0.steps.0.gaps.b",
          "not_compared",
        ]),
      );
      const broken = structuredClone(comparison) as Record<string, unknown>;
      const segments = path.split(".");
      let parent = broken;
      for (const segment of segments.slice(0, -1)) parent = parent[segment] as Record<string, unknown>;
      delete parent[segments[segments.length - 1]!];
      const result = parseRunDocument(JSON.stringify({ ...VALID, paths: [broken] }));
      expect("problem" in result && result.problem).toContain("paths.0.");
    }));

  it("reads a claim step's events readings and a count judged again at the world's stop, and refuses an outcome no count judgment gives", () => {
    const reading = {
      of: { step_record_id: "s1", step: "a", line: 4 },
      trace_id: "0af7651916cd43dd8448eb211c80319c",
      count: { kind: "db", op: "insert" },
      range: { at_least: 0, at_most: null },
      whole: false,
      open: [{ gap: "jobs-pending", job_ids: ["3f2a9c41"] }],
      maybe: { unreadable: 0, undefined_kind: 0, unknown_version: 0, field_unknown: 0, holds_unknown: 0, commit_unknown: 0, unowned: 0 },
      lines: 1,
      unreadable: 0,
      unowned: 0,
      file: "events-read.jsonl",
      waited_ms: 12,
    };
    const claim = (outcome: string) => ({
      actual_range: { at_least: 0, at_most: null },
      actual_from: "events:writes",
      compare: "equal",
      expected: 0,
      expected_from: "literal:nothing",
      expected_text: "nothing",
      outcome: "unjudged",
      measured: { step_record_id: "s2", channel: "events_read.writes" },
      after_world_stop: { lines: 3, range: { at_least: 1, at_most: 1 }, outcome, reason: "2 lines arrived after the claim" },
    });
    const withStep = (outcome: string) => ({
      ...VALID,
      scenarios: [
        {
          ...VALID.scenarios[0],
          steps: [...VALID.scenarios[0]!.steps, { line: 5, text: "nothing", step: "b", status: "failed", step_record_id: "s2", record: "steps/s2", events_read: { writes: reading }, claims: [claim(outcome)] }],
        },
      ],
    });
    expect(parseRunDocument(JSON.stringify(withStep("broken")))).toHaveProperty("document");
    const refused = parseRunDocument(JSON.stringify(withStep("unobserved")));
    // A claim is one of two shapes, so the refusal names the claim.
    expect("problem" in refused && refused.problem).toContain("scenarios.0.steps.1.claims.0: ");
  });

  it("refuses another schema version before it reads a field", () => {
    expect(parseRunDocument(JSON.stringify({ schema_version: 2 }))).toEqual({ problem: "has schema_version 2, and this release reads 4" });
    expect(parseRunDocument("[")).toEqual({ problem: "does not parse as JSON: Unexpected end of JSON input" });
  });
});
