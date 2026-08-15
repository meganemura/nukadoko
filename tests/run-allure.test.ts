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
// allure-results at all, and (allure-step-as-test task spec) the three
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
    // passing.feature has two steps (allure-step-as-test task spec, decision
    // 1: step = test, so step count = test count) — no longer one file for
    // the whole scenario.
    const record = JSON.parse(stdoutLines[0]!) as { steps: unknown[] };
    expect(resultFiles(resultsDir)).toHaveLength(record.steps.length);
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
    expect(resultFiles(resultsDir)).toHaveLength(2);
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

  it("writes a step's own test the moment that step finishes, not batched at scenario end (allure-step-as-test task spec, decision 2 — observed via real file mtimes, not by reading the code)", async () => {
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
    expect(files).toHaveLength(2);

    // Identify each file by its own mapped `start` (the step record's own
    // started_at, map-scenario.ts's `mapStep`) rather than by array order,
    // which readdirSync makes no guarantee about.
    const results = files.map((name) => ({ name, body: readResult(resultsDir, name) as { start?: number } }));
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

  it("writes the same Allure output whether or not --quiet is given (this task's spec, decision 3: the report's own granularity does not follow the terminal's)", async () => {
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

  it("never shares a historyId between two separate `nuka run` invocations against the same feature (this task's spec, decision 4 — the structural check that misconnection cannot happen)", async () => {
    const firstStdout = createCaptureSink();
    const firstStderr = createCaptureSink();
    const firstExit = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout: firstStdout,
      stderr: firstStderr,
    });
    expect(firstExit).toBe(0);

    const resultsDir = path.join(rootDir, ".nukadoko", "export", "allure-results");
    const firstHistoryIds = resultFiles(resultsDir).map((name) => (readResult(resultsDir, name) as { historyId?: string }).historyId);
    expect(firstHistoryIds).toHaveLength(2);
    expect(firstHistoryIds.every((id) => id !== undefined)).toBe(true);

    const secondStdout = createCaptureSink();
    const secondStderr = createCaptureSink();
    const secondExit = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout: secondStdout,
      stderr: secondStderr,
    });
    expect(secondExit).toBe(0);

    const allHistoryIds = resultFiles(resultsDir).map((name) => (readResult(resultsDir, name) as { historyId?: string }).historyId);
    // Both runs' own result files now sit in the same directory (this
    // emitter never deletes anything, allure-writer.test.ts's own
    // coverage) — 4 files, 4 distinct historyIds, none shared between the
    // two runs' own halves.
    expect(allHistoryIds).toHaveLength(4);
    expect(new Set(allHistoryIds).size).toBe(4);
    const secondHistoryIds = allHistoryIds.filter((id) => !firstHistoryIds.includes(id));
    expect(secondHistoryIds).toHaveLength(2);
  });
});
