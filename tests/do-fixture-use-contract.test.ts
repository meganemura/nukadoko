import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: P5 task spec's own completion condition 4 — a fixture
// that never calls use() must not hang `nuka run`/`nuka do`; it must fail,
// loudly, naming the fixture. Two shapes, both against tests/fixtures/
// user-fixtures-project: `neverCallsUse` returns immediately without
// calling use() at all (caught the instant its own function settles, no
// timeout wait needed); `stuckFixture` never settles and never calls
// use() either, caught only once its own short `options.timeout` (150ms)
// elapses — this task's spec, item 7's own "落ちるときはどの fixture で
// 止まったかを名指す". Both run through `nuka do` (one step, one execution)
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
    const receipt = JSON.parse(stdout.text());
    expect(receipt.status).toBe("failed");
    expect(receipt.error.kind).toBe("step_error");
    expect(receipt.error.message).toContain("neverCallsUse");
    expect(receipt.error.message).toContain("use(");
  }, 10_000);

  it("fails with a named timeout, never hanging, when the function never settles and never calls use()", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["do", "stuck-fixture-step", "--args", "{}"],
      { rootDir, stdout, stderr },
    );

    expect(exitCode).toBe(1);
    const receipt = JSON.parse(stdout.text());
    expect(receipt.status).toBe("failed");
    expect(receipt.error.message).toContain("stuckFixture");
    expect(receipt.error.message).toContain("timed out");
    expect(receipt.error.message).toContain("setup");
    // 150ms configured timeout; this assertion is really about "did not
    // hang for the process's own default", proven by the test itself
    // finishing well inside its own timeout budget below.
  }, 10_000);
});
