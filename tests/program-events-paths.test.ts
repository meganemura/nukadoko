import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: each step's coarse execution path in run.json, end to
// end, against tests/fixtures/events-project served in two environments
// that declare the two sides of the flag `quick_reorder`. The world's
// stop folds the path over every line of the step's trace, so the
// receipt's job, which performs after its step's record was written,
// counts in its step's path, and that path is whole.

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

describe("each step's path in run.json", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), PROGRAM);
    await writeFile(path.join(rootDir, FILE), FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("counts what each step's trace did, its late lines included, and leaves out the reads", async () => {
    const exitCode = await runCli(["run"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });

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
});
