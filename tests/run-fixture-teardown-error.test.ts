import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a fixture whose own teardown throws. src/fixture/
// resolver.ts's `teardownFixtureCache` never lets that failure change the
// scenario's own passed/failed status (a teardown failure is not a step
// failure), but it does still have to be visible somewhere:
// `ScenarioRecord.teardown_errors`, which tests/run-fixture-teardown.test.ts
// never exercises (nothing throws in that project's own fixtures). Against
// tests/fixtures/run-fixture-teardown-failure-project.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

describe("nuka run: a fixture whose own teardown fails", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-fixture-teardown-failure-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("keeps the scenario passed, and names the fixture and message under teardown_errors", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/teardown-failure.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    // A teardown failure never fails the run on its own.
    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps[0].status).toBe("passed");

    const teardownErrors = record.teardown_errors as ReadonlyArray<{ fixture: string; message: string }>;
    expect(teardownErrors).toHaveLength(1);
    expect(teardownErrors[0]!.fixture).toBe("brokenTeardown");
    expect(teardownErrors[0]!.message).toContain("brokenTeardown's own teardown exploded on purpose");
  });
});
