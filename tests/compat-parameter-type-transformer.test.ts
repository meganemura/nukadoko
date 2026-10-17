import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir, stripRunProgressLines } from "./helpers/fixtures.js";

// Responsibility: a compat `defineParameterType` transformer is applied the
// way cucumber-js applies one. Its `this` is the scenario World the step
// also runs against, and a Promise it returns is awaited before that step
// runs, so the step receives the resolved value. This holds for a string
// pattern's `{later}` and for a RegExp pattern's group alike.

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

describe("nuka run: a parameter-type transformer", () => {
  let rootDir: string;

  // runCli imports a command's module the first time it runs. Loaded here,
  // that import counts against the hook's budget, not the first test's.
  beforeAll(async () => {
    await import("../src/cli/run.js");
  });

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("compat-parameter-type-transformer-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it.each([
    ["a string pattern", "features/later.feature"],
    ["a RegExp pattern", "features/later-regexp.feature"],
  ])(
    "binds this to the step's World and awaits an async transformer before the step, in %s",
    async (_label, feature) => {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", feature], {
        rootDir,
        stdout,
        stderr,
      });

      expect(stripRunProgressLines(stderr.text())).toBe("");
      expect(exitCode).toBe(0);

      const lines = stdout
        .text()
        .split("\n")
        .filter((line) => line.length > 0);
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]!);
      expect(record.status).toBe("passed");
      expect(record.steps).toHaveLength(1);
      expect(record.steps[0].status).toBe("passed");

      const stepRecord = await readStepRecord(rootDir, record.steps[0].step_record_id);
      expect(stepRecord.args).toEqual(["SOON"]);
    },
  );
});
