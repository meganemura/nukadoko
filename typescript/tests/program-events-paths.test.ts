import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: each step's coarse execution path in run.json, end to
// end, against tests/fixtures/events-project served in two environments
// that declare the two sides of the flag `quick_reorder`. The world's
// stop folds the path over every line of the step's trace, so the
// receipt's job, which performs after its step's record was written,
// counts in its step's path, and that path is whole. The two
// environments' conditions differ in one, so run.json's `paths` compares
// their steps' paths, and the run summary lists what changed.

const FEATURE = [
  "Feature: Rooms, scores, and orders",
  "",
  "  Scenario: a room page reads the room",
  '    When the client gets "/rooms/7"',
  "",
  "  Scenario: a score is placed",
  '    When the client posts to "/scores"',
  '    Then "scores" was written 1 time',
  "",
  "  Scenario: a parked score is placed",
  '    When the client posts to "/scores?park=1"',
  '    And the client gets "/rooms/7"',
  "",
  "  Scenario: a customer opens an order",
  '    When customer "kim" opens order 7',
  "",
  "  @with:quick_reorder",
  "  Scenario: a reorder goes through",
  '    When customer "kim" reorders order 7',
  '    And the client posts to "/scores"',
  "",
  "  Scenario: a receipt goes out after the order",
  '    When customer "kim" asks for a receipt of order 7',
  "    And the step waits",
  "",
].join("\n");

const PROGRAM = [
  'import { defineProgram } from "./nukadoko-shim.js";',
  "",
  "export default defineProgram({",
  '  serve: { command: "node app/server.mjs", ready: "/up" },',
  '  env: { PORT: "{port}", EXECUTION_EVENTS: "{events}", ADMIN_TOKEN: "{token}", JOBS_DIR: "{dir}/jobs", QUICK_REORDER: "{condition.quick_reorder}" },',
  "  environments: {",
  '    "reorder-off": { conditions: { quick_reorder: false } },',
  '    "reorder-on": { conditions: { quick_reorder: true } },',
  "  },",
  "});",
  "",
].join("\n");

const FILE = "features/events.feature";

interface StepFacts {
  readonly line: number | null;
  readonly text: string;
  readonly path?: unknown;
  readonly events_late?: unknown;
}

interface ScenarioFacts {
  readonly line: number;
  readonly environment: string;
  readonly steps: readonly StepFacts[];
}

describe("each step's path in run.json, and the paths of two environments compared", () => {
  let rootDir: string;
  let exitCode: number;

  // One run serves every test here: it starts two worlds.
  beforeAll(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), PROGRAM);
    await writeFile(path.join(rootDir, FILE), FEATURE);
    exitCode = await runCli(["run"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
  }, 120_000);

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("counts what each step's trace did, its late lines included, and leaves out the reads", () => {
    expect(exitCode).toBe(0);
    const run = latestRunJson(rootDir) as { scenarios: ScenarioFacts[] };
    const step = (environment: string, line: number): StepFacts => {
      const found = run.scenarios.flatMap((scenario) => (scenario.environment === environment ? scenario.steps : [])).find((entry) => entry.line === line);
      expect(found, `${environment}:${line}`).toBeDefined();
      return found!;
    };

    expect(step("reorder-off", 4).path).toEqual({ requests: [{ method: "GET", route: "/rooms/:id", status: 200 }], entries: [], maybe: 0, open: [] });
    expect(step("reorder-on", 7).path).toEqual({
      requests: [{ method: "POST", route: "/scores", status: 303 }],
      entries: [
        { kind: "db", table: "rankings", op: "update", count: 1 },
        { kind: "db", table: "scores", op: "insert", count: 1 },
        { kind: "job", name: "ScoreRecalcJob", phase: "enqueue", count: 1 },
        { kind: "job", name: "ScoreRecalcJob", phase: "perform", count: 1 },
      ],
      maybe: 0,
      open: [],
    });
    // A Then that sent nothing has an empty path, which says so.
    expect(step("reorder-on", 8).path).toEqual({ requests: [], entries: [], maybe: 0, open: [{ gap: "no-requests" }] });
    expect(step("reorder-off", 11).path).toMatchObject({ open: [{ gap: "jobs-pending" }] });
    expect(step("reorder-off", 19).path).toEqual({
      requests: [{ method: "POST", route: "/reorders", status: 403 }],
      entries: [{ kind: "flag", name: "quick_reorder", side: "off", count: 1, gates: ["boolean"] }],
      maybe: 0,
      open: [],
    });
    // The step after the one that failed never ran, so it has no path.
    expect(step("reorder-off", 20)).not.toHaveProperty("path");

    // The receipt's job performs 600 ms after its request: after the
    // step's record, whose own reading is still open. Its path, read when
    // the world stopped, holds the job's lines and is whole.
    const receipt = step("reorder-on", 23);
    expect(receipt.events_late).toMatchObject({ lines: 3 });
    expect(receipt.path).toEqual({
      requests: [{ method: "POST", route: "/receipts", status: 202 }],
      entries: [
        { kind: "db", table: "rankings", op: "update", count: 1 },
        { kind: "job", name: "ReceiptJob", phase: "enqueue", count: 1 },
        { kind: "job", name: "ReceiptJob", phase: "perform", count: 1 },
        { kind: "flag", name: "quick_reorder", side: "on", count: 1, gates: [null] },
      ],
      maybe: 0,
      open: [],
    });
  });

  it("compares the two environments' paths step by step, with the flag they switch as the premise, and the summary lists what changed", () => {
    const run = latestRunJson(rootDir) as { paths: { counts: unknown; criteria: { line: number; result: string; steps?: unknown }[] }[] };
    expect(run.paths).toHaveLength(1);
    const [pair] = run.paths;
    expect(pair).toMatchObject({
      between: { kind: "condition", name: "quick_reorder", a: false, b: true },
      a: { world: "head", environment: "reorder-off" },
      b: { world: "head", environment: "reorder-on" },
      unread: null,
      counts: { changed: 1, open: 0, same_so_far: 1, marked_only: 0, same: 4, not_compared: 0 },
      not_compared: [],
    });
    expect(pair!.criteria.map((criterion) => [criterion.line, criterion.result])).toEqual([
      [3, "same"],
      [6, "same"],
      [10, "same_so_far"],
      [14, "same"],
      [18, "changed"],
      [22, "same"],
    ]);
    expect(pair!.criteria.find((criterion) => criterion.line === 18)!.steps).toEqual([
      {
        line: 19,
        text: 'customer "kim" reorders order 7',
        ran: "both",
        changed: [
          { kind: "request", method: "POST", route: "/reorders", status: 201, a: { at_least: 0, at_most: 0 }, b: { at_least: 1, at_most: 1 } },
          { kind: "request", method: "POST", route: "/reorders", status: 403, a: { at_least: 1, at_most: 1 }, b: { at_least: 0, at_most: 0 } },
        ],
        open: [],
        gaps: { a: [], b: [] },
      },
      { line: 20, text: 'the client posts to "/scores"', ran: "b" },
    ]);

    const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8").split("\n");
    const start = summary.indexOf("## Changed paths");
    expect(summary.slice(start, summary.indexOf("## Flags"))).toEqual([
      "## Changed paths",
      "",
      "Each criterion below did something else on one side than on the other, or may have, step by step, as the program's execution events report it. " +
        "A count that a side's missing lines could still reach is listed as open, never as a change. " +
        "A criterion whose open counts read the same on both sides, under the same gaps, is the same so far, and comes last. " +
        "Between two environments, what they switch is named in the heading, so no flag's side is listed among the changes.",
      "",
      "### `reorder-off` → `reorder-on` (`quick_reorder` false → true)",
      "",
      "6 criteria compared: 1 changed, 1 the same so far, 4 the same.",
      "",
      "- `features/events.feature:18` a reorder goes through",
      '  - line 19 `customer "kim" reorders order 7`: requests `POST /reorders` 403 → 201',
      "  - line 20 ran only in `reorder-on`, since `reorder-off` stopped at line 19 (`broke@19`): 2 writes, 2 jobs, 1 request",
      "- `features/events.feature:10` a parked score is placed: the same so far, with `jobs-pending` on both sides",
      "",
    ]);
  });
});
