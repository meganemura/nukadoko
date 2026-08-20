import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a scenario nested under a `Rule:` block runs like any
// other (src/run/run-scenario.ts's own keyword resolution walks
// `child.rule?.children` alongside a feature's own top-level scenarios, not
// only the latter), proven end to end, not just "the feature parses",
// since a step's own trace chunk title is built from that same walk. Against
// tests/fixtures/run-project.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

describe("nuka run: a scenario nested under Rule", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("runs to completion, step records and all", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/rule.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(1);
    expect(record.steps[0].status).toBe("passed");
    expect(typeof record.steps[0].step_record_id).toBe("string");
  });
});
