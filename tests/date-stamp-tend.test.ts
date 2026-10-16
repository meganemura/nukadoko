import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// A step that returns a Date or a bigint has to survive the real write
// path: the stored form, then JSON.stringify into the step record. An empty
// object in the record, or a run that aborts on the bigint, is the bug.

async function runAndReadStepRecord(rootDir: string, feature: string): Promise<string> {
  const runExit = await runCli(["run", feature], {
    rootDir,
    stdout: createCaptureSink(),
    stderr: createCaptureSink(),
  });
  expect(runExit).toBe(0);
  const stepsDir = path.join(rootDir, ".nukadoko", "records", "steps");
  const stepIds = await readdir(stepsDir);
  expect(stepIds).toHaveLength(1);
  return readFile(path.join(stepsDir, stepIds[0]!, "record.json"), "utf8");
}

describe("a recorded Date or bigint result", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("date-stamp-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("records a Date as its ISO string in the step record", async () => {
    const record = await runAndReadStepRecord(rootDir, "elsewhere/stamp.feature");
    expect(record).toContain('"createdAt": "2026-01-02T03:04:05.000Z"');
    expect(record).not.toContain('"createdAt": {}');
  });

  it("records a bigint as its decimal string in the step record", async () => {
    const record = await runAndReadStepRecord(rootDir, "elsewhere/atoms.feature");
    expect(record).toContain('"total": "123456789012345678901234567890"');
    expect(record).toContain('"coerced": "123456789012345678901234567890"');
  });
});
