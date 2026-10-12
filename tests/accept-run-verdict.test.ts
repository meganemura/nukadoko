import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka accept` and a run's verdict. An AfterAll hook that
// throws after every scenario passed leaves green scenario records and a run
// that exited 1, which no scenario record shows.

describe("nuka accept after a run whose AfterAll hook threw", () => {
  let rootDir: string;
  const failEnv = process.env.NUKA_AFTERALL_FAIL;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-marker-project");
    await initGitRepo(rootDir);
  });

  afterEach(async () => {
    if (failEnv === undefined) delete process.env.NUKA_AFTERALL_FAIL;
    else process.env.NUKA_AFTERALL_FAIL = failEnv;
    await removeTempDir(rootDir);
  });

  it("refuses the run and names the verdict, then accepts a later run that passed", async () => {
    process.env.NUKA_AFTERALL_FAIL = "1";
    const runStderr = createCaptureSink();
    expect(
      await runCli(["run", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr: runStderr }),
    ).toBe(1);

    const refused = createCaptureSink();
    expect(await runCli(["accept", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr: refused })).toBe(1);
    expect(refused.text()).toContain('its completion marker records verdict "failed"');
    expect(refused.text()).not.toContain("—");

    delete process.env.NUKA_AFTERALL_FAIL;
    expect(
      await runCli(["run", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() }),
    ).toBe(0);
    const accepted = createCaptureSink();
    expect(await runCli(["accept", "features/greeting.feature"], { rootDir, stdout: accepted, stderr: createCaptureSink() })).toBe(0);
  });

  it("refuses a run that has no marker at all, and says to run again", async () => {
    expect(
      await runCli(["run", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() }),
    ).toBe(0);
    const runsDir = path.join(rootDir, ".nukadoko", "records", "runs");
    for (const runId of readdirSync(runsDir)) rmSync(path.join(runsDir, runId, "complete.json"), { force: true });

    const refused = createCaptureSink();
    expect(await runCli(["accept", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr: refused })).toBe(1);
    expect(refused.text()).toContain("has no completion marker");
    expect(refused.text()).toContain("nuka run features/greeting.feature");
  });
});
