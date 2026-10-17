import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a fixture
// that never calls use() must not hang `nuka run`/`nuka do`; it must fail,
// loudly, naming the fixture. Two shapes, both against tests/fixtures/
// user-fixtures-project: `neverCallsUse` returns immediately without
// calling use() at all (caught the instant its own function settles, no
// timeout wait needed); `stuckFixture` never settles and never calls
// use() either, caught only once its own short `options.timeout` (150ms)
// elapses, and the error names that fixture and that timeout.
// Both run through `nuka do` (one step, one execution)
// so exit code and stderr are read directly, with no scenario/pickle
// machinery in the way.

describe("nuka do: a fixture that never calls use() fails, never hangs", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("user-fixtures-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("fails immediately, naming the fixture, when the function returns without calling use()", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["do", "never-calls-use-step", "--args", "{}"],
      { rootDir, stdout, stderr },
    );

    expect(exitCode).toBe(1);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("failed");
    expect(stepRecord.error.kind).toBe("step_error");
    expect(stepRecord.error.message).toContain("neverCallsUse");
    expect(stepRecord.error.message).toContain("use(");
  });

  it("fails with a named timeout, never hanging, when the function never settles and never calls use()", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["do", "stuck-fixture-step", "--args", "{}"],
      { rootDir, stdout, stderr },
    );

    expect(exitCode).toBe(1);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("failed");
    // The fixture's own 150ms, not the project's 2000ms fixtureTimeout:
    // the timeout that ended the wait is named, so no duration is measured.
    expect(stepRecord.error.message).toContain('Fixture "stuckFixture" timed out during setup after 150ms');
  });
});
