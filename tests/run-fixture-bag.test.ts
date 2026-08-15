import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: an unknown fixture name, or a default value on a
// destructured fixture,
// refuses execution entirely (setup-phase fatal, same family as a broken
// `from`, tests/run-from-order.test.ts's own "refuses the whole run, before
// any scenario record is written" test) rather than letting the step run
// and fail. Exercised through both `nuka run` and `nuka do` — the two
// executors src/step/validate-fixtures.ts's shared judgment protects.

describe("nuka run: fixture bag's structural refusal", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("fixture-bag-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("refuses the whole run, before any scenario record is written, for an unknown fixture name", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/fixture-bag.feature"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    // Setup-phase fatal, same family as a structurally broken `from` — no
    // scenario record line is ever printed,
    // not even for the clean-step scenario in the same feature file: this
    // step's own `run` was never called, so no browser session could ever
    // have been opened for it either.
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("unknown-fixture-step");
    expect(stderr.text()).toContain('unknown fixture "bogus"');
  });
});

describe("nuka do: fixture bag's structural refusal", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("fixture-bag-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("refuses an unknown fixture name before the step ever runs — no step record written", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "unknown-fixture-step", "--args", "{}"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    // Setup-phase, not the step's own failure: `stdout` never receives a
    // step record JSON at all (cli/do.ts's own contract — a setup failure
    // writes nothing).
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain('unknown fixture "bogus"');
  });

  it("refuses a default value on a destructured fixture, by its own dedicated message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "default-value-step", "--args", "{}"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("default value");
  });

  it("refuses a rest property in the fixture destructuring", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "rest-step", "--args", "{}"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("rest property");
  });

  it("refuses a run() whose first argument isn't destructured at all", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "not-destructured-step", "--args", "{}"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("destructure");
  });

  it("runs a clean step normally — args/env fixtures resolve, step record is written, exit 0", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "clean-step", "--args", "{}"], { rootDir, stdout, stderr });

    expect(stderr.text()).toBe("");
    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("ok");
    expect(stepRecord.result).toEqual({ ok: true });
  });
});
