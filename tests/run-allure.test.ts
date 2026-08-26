import { existsSync, readFileSync, readdirSync } from "node:fs";
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
// isolation inside `emitStep`/`endScenario` — is already covered by
// tests/allure-emitter.test.ts's own integration tests against
// createAllureEmitter directly; this file only proves what cli/run.ts adds
// on top: the default output location, config.allure.resultsDir overriding
// it, the `hasPickles` gate that keeps a pickle-less run from creating
// allure-results at all, and the two facts only a real `nuka run`
// invocation can prove: `--quiet` leaves Allure's own output untouched, and
// two separate invocations against the same feature share one historyId.
//
// One result file per scenario now, never per step: every `resultFiles`
// count below reads `record.length` (the number of scenario records `nuka
// run` streamed to stdout), not a per-step tally. A step's own test used to
// be written the moment that step finished, observable through real file
// mtimes; there is no such moment left to observe now that a scenario's own
// steps are nested inside one result written once, at the scenario's own
// end, which is why that timing test is gone rather than adapted.

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

  it("writes categories.json, environment.properties, and one result file per scenario under the default .nukadoko/export/allure-results/", async () => {
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
    // One pickle, one Allure test result — passing.feature's own two steps
    // nest inside it rather than getting a file of their own.
    const record = JSON.parse(stdoutLines[0]!) as { steps: unknown[] };
    expect(resultFiles(resultsDir)).toHaveLength(1);
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
    // One result file for this one pickle (this file's first test above).
    expect(resultFiles(resultsDir)).toHaveLength(1);
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

  it("shares one historyId between two separate `nuka run` invocations against the same feature", async () => {
    interface ResultLike {
      readonly historyId?: string;
    }
    function historyIds(resultsDir: string): (string | undefined)[] {
      return resultFiles(resultsDir).map((name) => (readResult(resultsDir, name) as ResultLike).historyId);
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
    const first = historyIds(resultsDir);
    expect(first).toHaveLength(1);
    expect(first[0]).toBeDefined();

    const secondStdout = createCaptureSink();
    const secondStderr = createCaptureSink();
    const secondExit = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout: secondStdout,
      stderr: secondStderr,
    });
    expect(secondExit).toBe(0);

    // Both runs' own result files now sit in the same directory (this
    // emitter never deletes anything, allure-writer.test.ts's own
    // coverage): two runs of the exact same feature produce 2 files but 1
    // historyId, the entire reason `mapScenario`'s own step-signature
    // parameter exists (map-scenario.ts's own header) -- a scenario's own
    // identity is meant to survive a rerun, unlike a run/step id.
    const all = historyIds(resultsDir);
    expect(all).toHaveLength(2);
    expect(new Set(all).size).toBe(1);
    expect(all[0]).toBe(first[0]);
  });
});
