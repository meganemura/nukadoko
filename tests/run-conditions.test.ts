import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run --env a --env b`, one run over two
// environments. The fixture's two environments differ in one env value, so
// "the banner is on" passes in flag-on and fails in flag-off. The run has
// one run_id, one exit code that is red because one row is red, one
// cell per scenario and environment, and a rerun line that lands in the
// environment the failure came from. It holds at `--concurrency 2` and
// under `--repeat` and a `:line` target as well, and an environment named
// twice is refused before anything runs.

const ENVS = ["--env", "flag-on", "--env", "flag-off"];

async function run(argv: readonly string[]) {
  const rootDir = await copyFixtureToTempDir("run-conditions-project");
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  try {
    const exitCode = await runCli(["run", ...argv], { rootDir, stdout, stderr });
    // A refused run writes no run.json, so there is nothing to read.
    const document = exitCode === 2 ? {} : latestRunJson(rootDir);
    return { exitCode, document, stderr: stderr.text(), stdout: stdout.text() };
  } finally {
    await removeTempDir(rootDir);
  }
}

type Row = { feature: string; line: number; cells: { environment: string; outcome: string; line?: number; runs: number }[] };
// Each cell of the verdict table as [feature, line, environment, what it
// came to, runs], rows in table order and cells in environment order.
const cells = (document: Record<string, any>) =>
  (document.table.rows as readonly Row[]).flatMap((row) =>
    row.cells.map((cell) => [row.feature, row.line, cell.environment, cell.line === undefined ? cell.outcome : `${cell.outcome}@${cell.line}`, cell.runs]),
  );

describe("nuka run over several environments", () => {
  it("runs every scenario once per environment in one run, and is red because one cell is red", async () => {
    const { exitCode, document, stderr } = await run(["features/", ...ENVS]);
    expect(exitCode).toBe(1);
    expect(document.environments).toEqual([
      { name: "flag-on", target_version: "2.0.0", base_url: "http://127.0.0.1:3201" },
      { name: "flag-off", target_version: null, base_url: null },
    ]);
    expect(document.verdict).toBe("failed");
    expect(document.counts).toEqual({ scenarios: 6, passed: 5, failed: 1, stopped: 0, not_run: 0, controls: 0, controls_not_run: 0 });
    expect(new Set(document.scenarios.map((scenario: { environment: string }) => scenario.environment))).toEqual(
      new Set(["flag-on", "flag-off"]),
    );
    expect(cells(document)).toEqual([
      ["features/banner.feature", 3, "flag-on", "pass", 1],
      ["features/banner.feature", 3, "flag-off", "fail@4", 1],
      ["features/banner.feature", 6, "flag-on", "pass", 1],
      ["features/banner.feature", 6, "flag-off", "pass", 1],
      ["features/page.feature", 3, "flag-on", "pass", 1],
      ["features/page.feature", 3, "flag-off", "pass", 1],
    ]);
    expect(document.findings).toEqual([
      {
        severity: "failed",
        code: "scenario-failed",
        file: "features/banner.feature",
        line: 3,
        message: 'the banner is on (flag-off): claim broken: "off" (observe:banner) equal "on" (sentence:state)',
        do: "nuka run features/banner.feature:3 --env flag-off",
      },
    ]);
    expect(stderr).toContain("environment flag-on\n");
    expect(stderr).toContain("environment flag-off\n");
    expect(stderr).toContain("scenario 6/6  ");
  });

  it("gives the same cells at --concurrency 2", async () => {
    const { exitCode, document } = await run(["features/", ...ENVS, "--concurrency", "2"]);
    expect(exitCode).toBe(1);
    expect(cells(document)).toEqual([
      ["features/banner.feature", 3, "flag-on", "pass", 1],
      ["features/banner.feature", 3, "flag-off", "fail@4", 1],
      ["features/banner.feature", 6, "flag-on", "pass", 1],
      ["features/banner.feature", 6, "flag-off", "pass", 1],
      ["features/page.feature", 3, "flag-on", "pass", 1],
      ["features/page.feature", 3, "flag-off", "pass", 1],
    ]);
    expect(document.findings.map((finding: { do?: string }) => finding.do)).toEqual([
      "nuka run features/banner.feature:3 --env flag-off",
    ]);
  });

  it("folds --repeat into one cell per environment, and runs a :line target in each", async () => {
    const { exitCode, document, stderr } = await run(["features/banner.feature:3", ...ENVS, "--repeat", "2"]);
    expect(exitCode).toBe(1);
    expect(cells(document)).toEqual([
      ["features/banner.feature", 3, "flag-on", "pass", 2],
      ["features/banner.feature", 3, "flag-off", "fail@4", 2],
    ]);
    // A tally line is written only for a scenario that failed at least once,
    // and it names the environment it failed in.
    expect(stderr.split("\n").filter((line) => line.startsWith("repeat  "))).toEqual([
      "repeat  features/banner.feature:3  the banner is on (flag-off)  0 of 2 passed",
    ]);
  });

  it("is green when every cell is green", async () => {
    const { exitCode, document } = await run(["features/page.feature", ...ENVS]);
    expect(exitCode).toBe(0);
    expect(document.verdict).toBe("passed");
    expect(cells(document)).toEqual([
      ["features/page.feature", 3, "flag-on", "pass", 1],
      ["features/page.feature", 3, "flag-off", "pass", 1],
    ]);
  });

  it("keeps the single-environment shape: one cell per scenario, no environment in the messages", async () => {
    const { exitCode, document } = await run(["features/banner.feature", "--env", "flag-off"]);
    expect(exitCode).toBe(1);
    expect(cells(document)).toEqual([
      ["features/banner.feature", 3, "flag-off", "fail@4", 1],
      ["features/banner.feature", 6, "flag-off", "pass", 1],
    ]);
    expect(document.findings).toEqual([
      {
        severity: "failed",
        code: "scenario-failed",
        file: "features/banner.feature",
        line: 3,
        message: 'the banner is on: claim broken: "off" (observe:banner) equal "on" (sentence:state)',
        do: "nuka run features/banner.feature:3 --env flag-off",
      },
    ]);
  });

  it("refuses an environment named twice, and writes nothing", async () => {
    const { exitCode, stderr, stdout } = await run(["features/", "--env", "flag-on", "--env", "flag-on"]);
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain('refused\tinvalid-value\t-\t--env names "flag-on" more than once\n');
  });
});
