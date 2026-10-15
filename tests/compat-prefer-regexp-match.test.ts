import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir, stripRunProgressLines } from "./helpers/fixtures.js";

// Responsibility: a compat `defineParameterType({ preferForRegexpMatch })`
// decides which of two matching parameter types converts a RegExp group,
// as it does in cucumber-js.

describe("nuka run: preferForRegexpMatch", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("compat-prefer-regexp-match-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("converts a RegExp group with the preferred type when two types match it", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/code.feature"], { rootDir, stdout, stderr });

    expect(stripRunProgressLines(stderr.text())).toBe("");
    expect(exitCode).toBe(0);

    const record = JSON.parse(stdout.text().trim());
    expect(record.steps[0].status).toBe("passed");
    const stepRecordPath = path.join(
      rootDir,
      ".nukadoko",
      "records",
      "steps",
      record.steps[0].step_record_id,
      "record.json",
    );
    expect(JSON.parse(await readFile(stepRecordPath, "utf8")).args).toEqual(["B:ABC"]);
  });
});
