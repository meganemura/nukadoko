import { existsSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run` -> allure-results wiring, end to end (m3b-
// allure-emitter spec-b2 task spec, test item 2). The mapping itself —
// labels, parameters, attachments, identity, failure isolation inside
// emitScenario — is already covered by tests/allure-emitter.test.ts's own
// integration tests against createAllureEmitter directly; this file only
// proves what cli/run.ts adds on top: the default output location,
// config.allure.resultsDir overriding it, and the `hasPickles` gate that
// keeps a pickle-less run from creating allure-results at all. Reuses
// run-project (run.test.ts's own fixture) rather than a new one — its
// features/passing.feature scenario and features/empty.feature (added by
// this task) already cover both cases this file needs.

function resultFileNames(resultsDir: string): string[] {
  return readdirSync(resultsDir).filter((name) => name.endsWith("-result.json"));
}

describe("nuka run: allure-results wiring", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes categories.json, environment.properties, and one result file under the default .nukadoko/allure-results/", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    // stdout/exit code are unchanged by the emitter (this task's spec, item
    // 2) — the same one-record-line assertion run.test.ts's own "runs a
    // pure-step scenario to completion" test makes.
    expect(stderr.text()).toBe("");
    const stdoutLines = stdout.text().split("\n").filter((line) => line.length > 0);
    expect(stdoutLines).toHaveLength(1);

    const resultsDir = path.join(rootDir, ".nukadoko", "allure-results");
    expect(existsSync(path.join(resultsDir, "categories.json"))).toBe(true);
    expect(existsSync(path.join(resultsDir, "environment.properties"))).toBe(true);
    expect(resultFileNames(resultsDir)).toHaveLength(1);
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
    expect(stderr.text()).toBe("");

    const resultsDir = path.join(rootDir, "reports", "allure");
    expect(existsSync(path.join(resultsDir, "categories.json"))).toBe(true);
    expect(resultFileNames(resultsDir)).toHaveLength(1);
    // The default location is untouched — the override moves the output,
    // it doesn't add a second copy.
    expect(existsSync(path.join(rootDir, ".nukadoko", "allure-results"))).toBe(false);
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
    expect(stderr.text()).toBe("");
    expect(existsSync(path.join(rootDir, ".nukadoko", "allure-results"))).toBe(false);
  });
});
