import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  removeTempDir,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: `nuka run` -> allure-results wiring, end to end. The
// mapping itself — labels, parameters, attachments, identity, failure
// isolation inside a step's own emitStep — is already covered by
// tests/allure-emitter.test.ts's own integration tests against
// createAllureEmitter directly; this file only proves what cli/run.ts adds
// on top: the default output location, config.allure.resultsDir overriding
// it, the `hasPickles` gate that keeps a pickle-less run from creating
// allure-results at all, and the three
// facts only a real `nuka run` invocation can prove: a step's own test is
// written live rather than batched (observed via real file mtimes, not by
// reading the code), `--quiet` leaves Allure's own output untouched, and
// two separate invocations against the same feature never share a
// historyId.

function resultFiles(resultsDir: string): string[] {
  return readdirSync(resultsDir).filter((name) => name.endsWith("-result.json"));
}

function readResult(resultsDir: string, fileName: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(resultsDir, fileName), "utf8"));
}

describe("nuka run: allure-results wiring", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes categories.json, environment.properties, and one result file per step under the default .nukadoko/export/allure-results/", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    // stdout/exit code are unchanged by the emitter — the same one-record-
    // line assertion run.test.ts's own "runs a pure-step scenario to
    // completion" test makes.
    expect(stripRunProgressLines(stderr.text())).toBe("");
    const stdoutLines = stdout.text().split("\n").filter((line) => line.length > 0);
    expect(stdoutLines).toHaveLength(1);

    const resultsDir = path.join(rootDir, ".nukadoko", "export", "allure-results");
    expect(existsSync(path.join(resultsDir, "categories.json"))).toBe(true);
    expect(existsSync(path.join(resultsDir, "environment.properties"))).toBe(true);
    // passing.feature has two steps (step = test, so step count = test
    // count), plus the one scenario-level test `endScenario` adds on top
    // (map-scenario.ts's own `mapScenario`): one file per step, and one
    // more for the scenario as a whole.
    const record = JSON.parse(stdoutLines[0]!) as { steps: unknown[] };
    expect(resultFiles(resultsDir)).toHaveLength(record.steps.length + 1);
    expect(record.steps.length).toBe(2);
  });

  it("writes to allure.resultsDir instead, root-relative, when config sets it", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        "",
        "export default defineConfig({ allure: { resultsDir: \"reports/allure\" } });",
        "",
      ].join("\n"),
    );

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stripRunProgressLines(stderr.text())).toBe("");

    const resultsDir = path.join(rootDir, "reports", "allure");
    expect(existsSync(path.join(resultsDir, "categories.json"))).toBe(true);
    // Two steps' own tests, plus one scenario-level test (this file's first
    // test above).
    expect(resultFiles(resultsDir)).toHaveLength(3);
    // The default location is untouched — the override moves the output,
    // it doesn't add a second copy.
    expect(existsSync(path.join(rootDir, ".nukadoko", "export", "allure-results"))).toBe(false);
  });

  it("creates no allure-results directory at all for a run that selects zero pickles", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/empty.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stripRunProgressLines(stderr.text())).toBe("");
    expect(existsSync(path.join(rootDir, ".nukadoko", "export", "allure-results"))).toBe(false);
  });

  it("writes a step's own test the moment that step finishes, not batched at scenario end (observed via real file mtimes, not by reading the code)", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/two-steps-timing.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);

    const resultsDir = path.join(rootDir, ".nukadoko", "export", "allure-results");
    const files = resultFiles(resultsDir);
    // Two steps' own tests, plus one scenario-level test, excluded below
    // before this test's own two-file comparison: the scenario-level test
    // is written once, at `endScenario`, after both steps already finished
    // (map-scenario.ts's own `mapScenario`), so it has nothing to say about
    // whether a *step's* own test is written live.
    expect(files).toHaveLength(3);
    const stepFiles = files.filter((name) => !(readResult(resultsDir, name) as { name?: string }).name?.startsWith("Scenario: "));
    expect(stepFiles).toHaveLength(2);

    // Identify each file by its own mapped `start` (the step record's own
    // started_at, map-scenario.ts's `mapStep`) rather than by array order,
    // which readdirSync makes no guarantee about.
    const results = stepFiles.map((name) => ({ name, body: readResult(resultsDir, name) as { start?: number } }));
    results.sort((a, b) => (a.body.start ?? 0) - (b.body.start ?? 0));
    const [first, second] = results;

    // The real, filesystem-level mtime of each result.json — this is what
    // actually distinguishes "written live" from "batched at scenario end":
    // a batched emitter writes both within a few milliseconds of each
    // other regardless of how long the second step's own execution took.
    const firstMtime = statSync(path.join(resultsDir, first!.name)).mtimeMs;
    const secondMtime = statSync(path.join(resultsDir, second!.name)).mtimeMs;

    // features/steps/slow-second-step.ts sleeps ~300ms between the two
    // steps — a live emitter's own two file-write moments land that far
    // apart; a wide margin (200ms) absorbs scheduling/filesystem jitter
    // without weakening what this test actually proves.
    expect(secondMtime - firstMtime).toBeGreaterThanOrEqual(200);
  }, 15000);

  it("writes the same Allure output whether or not --quiet is given (the report's own granularity does not follow the terminal's)", async () => {
    const quietDir = await copyFixtureToTempDir("run-project");
    try {
      const loudStdout = createCaptureSink();
      const loudStderr = createCaptureSink();
      await runCli(["run", "features/passing.feature"], { rootDir, stdout: loudStdout, stderr: loudStderr });

      const quietStdout = createCaptureSink();
      const quietStderr = createCaptureSink();
      await runCli(["run", "features/passing.feature", "--quiet"], {
        rootDir: quietDir,
        stdout: quietStdout,
        stderr: quietStderr,
      });

      // `--quiet` does change stderr (fewer progress lines) — proving that
      // is not this test's job (tests/run-progress-log.test.ts already
      // does). What this test proves is that Allure's own output is
      // unaffected by it either way.
      const loudResultsDir = path.join(rootDir, ".nukadoko", "export", "allure-results");
      const quietResultsDir = path.join(quietDir, ".nukadoko", "export", "allure-results");
      expect(resultFiles(quietResultsDir)).toHaveLength(resultFiles(loudResultsDir).length);
      expect(existsSync(path.join(quietResultsDir, "categories.json"))).toBe(true);

      const loudNames = resultFiles(loudResultsDir)
        .map((name) => (readResult(loudResultsDir, name) as { name?: string }).name)
        .sort();
      const quietNames = resultFiles(quietResultsDir)
        .map((name) => (readResult(quietResultsDir, name) as { name?: string }).name)
        .sort();
      expect(quietNames).toEqual(loudNames);
    } finally {
      await removeTempDir(quietDir);
    }
  });

  it("never shares a step's own historyId between two separate `nuka run` invocations against the same feature, and always shares the scenario's own", async () => {
    interface ResultLike {
      readonly name?: string;
      readonly historyId?: string;
    }
    // Split by `mapScenario`'s own "Scenario: " name prefix (map-scenario.ts),
    // the only marker this test needs to tell the one scenario-level
    // result apart from its own two step-level ones.
    function historyIdsByGrain(resultsDir: string): { steps: (string | undefined)[]; scenarios: (string | undefined)[] } {
      const results = resultFiles(resultsDir).map((name) => readResult(resultsDir, name) as ResultLike);
      return {
        steps: results.filter((r) => !r.name?.startsWith("Scenario: ")).map((r) => r.historyId),
        scenarios: results.filter((r) => r.name?.startsWith("Scenario: ")).map((r) => r.historyId),
      };
    }

    const firstStdout = createCaptureSink();
    const firstStderr = createCaptureSink();
    const firstExit = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout: firstStdout,
      stderr: firstStderr,
    });
    expect(firstExit).toBe(0);

    const resultsDir = path.join(rootDir, ".nukadoko", "export", "allure-results");
    const first = historyIdsByGrain(resultsDir);
    expect(first.steps).toHaveLength(2);
    expect(first.steps.every((id) => id !== undefined)).toBe(true);
    expect(first.scenarios).toHaveLength(1);
    expect(first.scenarios[0]).toBeDefined();

    const secondStdout = createCaptureSink();
    const secondStderr = createCaptureSink();
    const secondExit = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout: secondStdout,
      stderr: secondStderr,
    });
    expect(secondExit).toBe(0);

    const all = historyIdsByGrain(resultsDir);
    // Both runs' own result files now sit in the same directory (this
    // emitter never deletes anything, allure-writer.test.ts's own
    // coverage): 4 step-level files, 4 distinct historyIds, none shared
    // between the two runs' own halves (mapStep's own `identityParameters`,
    // map-scenario.ts's own header for why a step's own test can never
    // link across runs).
    expect(all.steps).toHaveLength(4);
    expect(new Set(all.steps).size).toBe(4);
    const secondStepHistoryIds = all.steps.filter((id) => !first.steps.includes(id));
    expect(secondStepHistoryIds).toHaveLength(2);

    // The opposite promise, on purpose, for the scenario-level file: two
    // runs of the exact same feature produce 2 files but 1 historyId, the
    // entire reason `mapScenario` exists (map-scenario.ts's own header).
    expect(all.scenarios).toHaveLength(2);
    expect(new Set(all.scenarios).size).toBe(1);
    expect(all.scenarios[0]).toBe(first.scenarios[0]);
  });
});
