import { readFileSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { parseRunDocument } from "../src/report/run-document-schema.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, latestRunJsonText, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: run.json's `flags` end to end, against
// tests/fixtures/events-project served in two environments that declare
// the two sides of the flag `quick_reorder`. The program's flag lines,
// not the environments' conditions, decide which side each criterion
// stands on: one scenario turns the flag on for one person in the world
// declared off, and the receipt's flag line comes from a job after its
// step's record. Each row counts its criteria by their table rows'
// verdicts, and a criterion seen on a side only in controls apart from
// them. Under --concurrency the world-stop pass reads every worker's lines.

const FEATURE = [
  "Feature: Reordering an order in one press",
  "",
  "  @with:quick_reorder",
  "  Scenario: a returning customer reorders from the order page",
  '    Then the page of order 7 for "kim" offers "reorder"',
  "",
  "  Scenario: a customer the switch was turned on for sees the reorder button",
  '    Given the reorder switch is turned on for "aki"',
  '    When customer "lee" opens order 7',
  '    Then the page of order 7 for "aki" offers "reorder"',
  "",
  "  @with:quick_reorder",
  "  Scenario: a reorder goes through",
  '    When customer "kim" reorders order 7',
  '    Then the page of order 7 for "kim" offers "reorder"',
  "",
  "  Scenario: a receipt goes out after the order",
  '    When customer "kim" asks for a receipt of order 7',
  "    And the step waits",
  "",
  "  Scenario: an order that is not there offers nothing",
  '    Then the page of order 404 for "kim" offers "reorder"',
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

function criterion(line: number, name: string, verdict: string, cells: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { feature: FILE, line, name, verdict, cells };
}

describe("run.json's flags", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), PROGRAM);
    await writeFile(path.join(rootDir, FILE), FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("gives each flag and side the criteria whose steps evaluated it there, by the side the lines name", async () => {
    const exitCode = await runCli(["run"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });

    // The order that is not there fails in both environments.
    expect(exitCode).toBe(1);
    const run = latestRunJson(rootDir);
    const reorder = criterion(4, "a returning customer reorders from the order page", "proven", []);
    const switched = criterion(7, "a customer the switch was turned on for sees the reorder button", "held", []);
    const reorders = criterion(13, "a reorder goes through", "held", []);
    const receipt = criterion(17, "a receipt goes out after the order", "held", []);
    const missing = criterion(21, "an order that is not there offers nothing", "failed", []);
    const pass = (environment: string, gates: readonly (string | null)[]) => ({ environment, role: "required", outcome: "pass", gates });
    expect(run.flags).toEqual([
      {
        name: "quick_reorder",
        side: "off",
        criteria: [
          // The control's Then failed in each of its two runs: the proof
          // stands on this side and the verdict on the other, so the
          // criterion is counted apart.
          { ...reorder, cells: [{ environment: "reorder-off", role: "control", outcome: "fail", line: 5, gates: ["boolean"] }] },
          { ...switched, cells: [pass("reorder-off", ["boolean"])] },
          // A control whose When broke is never proof: the row is held.
          { ...reorders, cells: [{ environment: "reorder-off", role: "control", outcome: "broke", line: 14, gates: ["boolean"] }] },
          // The job's line came after the step's record, and names no gate.
          { ...receipt, cells: [pass("reorder-off", [null])] },
          { ...missing, cells: [{ environment: "reorder-off", role: "required", outcome: "fail", line: 22, gates: ["boolean"] }] },
        ],
        counts: { held: 2, proven: 0, failed: 1, unproven: 0, moved: 0, controls: 2 },
      },
      {
        name: "quick_reorder",
        side: "on",
        criteria: [
          { ...reorder, cells: [pass("reorder-on", ["boolean"])] },
          // Turned on for aki alone in the world declared off: the same
          // execution stands on both sides.
          { ...switched, cells: [pass("reorder-off", ["actor"]), pass("reorder-on", ["boolean"])] },
          { ...reorders, cells: [pass("reorder-on", ["boolean"])] },
          { ...receipt, cells: [pass("reorder-on", [null])] },
          { ...missing, cells: [{ environment: "reorder-on", role: "required", outcome: "fail", line: 22, gates: ["boolean"] }] },
        ],
        counts: { held: 3, proven: 1, failed: 1, unproven: 0, moved: 0, controls: 0 },
      },
    ]);

    // The receipt's flag line is in no step's record, only in its late file.
    const receiptSteps = (run.scenarios as { line: number; steps: { text: string; observed: { events: { kinds: Record<string, number> } }; events_late?: { lines: number; file: string } }[] }[])
      .filter((scenario) => scenario.line === 17)
      .map((scenario) => scenario.steps[0]!);
    expect(receiptSteps).toHaveLength(2);
    for (const step of receiptSteps) {
      expect(step.observed.events.kinds).not.toHaveProperty("flag");
      expect(step.events_late?.file).toBe("events-late.jsonl");
    }

    // The summary gives each row one line: its counts, and the gates.
    const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8").split("\n");
    expect(summary.filter((line) => line.startsWith("- `quick_reorder`"))).toEqual([
      "- `quick_reorder` `off`, 5 criteria: 2 held, 1 failed, 2 only in controls; gates `boolean`, none named",
      "- `quick_reorder` `on`, 5 criteria: 3 held, 1 proven, 1 failed; gates `boolean`, `actor`, none named",
    ]);

    // `nuka report` reads the same document, flags included.
    expect("document" in parseRunDocument(latestRunJsonText(rootDir))).toBe(true);
  });

  it("reads the flag lines of every worker under --concurrency", async () => {
    await copyFile(path.join(rootDir, FILE), path.join(rootDir, "features", "events-again.feature"));
    const exitCode = await runCli(["run", "--concurrency", "2"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });

    expect(exitCode).toBe(1);
    const rows = latestRunJson(rootDir).flags as { side: string; criteria: { feature: string }[]; counts: Record<string, number> }[];
    expect(rows.map((row) => [row.side, row.criteria.map((entry) => entry.feature)])).toEqual(
      ["off", "on"].map((side) => [side, [...Array(5).fill("features/events-again.feature"), ...Array(5).fill(FILE)]]),
    );
    expect(rows.map((row) => row.counts)).toEqual([
      { held: 4, proven: 0, failed: 2, unproven: 0, moved: 0, controls: 4 },
      { held: 6, proven: 2, failed: 2, unproven: 0, moved: 0, controls: 0 },
    ]);
  });
});
