import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: whether `nuka run` writes its scenario records to stdout,
// decided by the stdout sink's `isTTY` and `--records`, at --concurrency 1
// and above. `nuka do` is here as the command the rule leaves alone.

function terminalSink(): ReturnType<typeof createCaptureSink> & { isTTY: true } {
  return Object.assign(createCaptureSink(), { isTTY: true as const });
}

function recordLines(text: string): Array<{ feature: string; status: string }> {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("nuka run: scenario records on stdout", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-concurrency-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes nothing to a terminal stdout, and still writes the records to disk", async () => {
    const stdout = terminalSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/basic/"], { rootDir, stdout, stderr });

    expect(exitCode, stderr.text()).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toMatch(/^scenarios \.nukadoko\/records\/scenarios\/\s+2$/m);
    expect(readdirSync(path.join(rootDir, ".nukadoko/records/scenarios"))).toHaveLength(2);
  });

  it("writes one record per scenario to a terminal stdout under --records", async () => {
    const stdout = terminalSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "--records", "features/basic/"], { rootDir, stdout, stderr });

    expect(exitCode, stderr.text()).toBe(0);
    expect(recordLines(stdout.text()).map((r) => [r.feature, r.status])).toEqual([
      ["features/basic/a.feature", "passed"],
      ["features/basic/b.feature", "passed"],
    ]);
  });

  it("writes one record per scenario to a stdout that is not a terminal", async () => {
    const stdout = Object.assign(createCaptureSink(), { isTTY: false });
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/basic/"], { rootDir, stdout, stderr });

    expect(exitCode, stderr.text()).toBe(0);
    expect(recordLines(stdout.text())).toHaveLength(2);
  });

  it("follows the same rule at --concurrency 2", async () => {
    const quietStdout = terminalSink();
    const quietStderr = createCaptureSink();
    const quietExit = await runCli(["run", "--no-check", "--concurrency", "2", "features/basic/"], {
      rootDir,
      stdout: quietStdout,
      stderr: quietStderr,
    });
    expect(quietExit, quietStderr.text()).toBe(0);
    expect(quietStdout.text()).toBe("");
    expect(quietStderr.text()).toMatch(/^2 scenarios: 2 passed, 0 failed/m);

    const recordsStdout = terminalSink();
    const recordsStderr = createCaptureSink();
    const recordsExit = await runCli(["run", "--no-check", "--records", "--concurrency", "2", "features/basic/"], {
      rootDir,
      stdout: recordsStdout,
      stderr: recordsStderr,
    });
    expect(recordsExit, recordsStderr.text()).toBe(0);
    expect(recordLines(recordsStdout.text()).map((r) => r.feature).sort()).toEqual([
      "features/basic/a.feature",
      "features/basic/b.feature",
    ]);
  });

  it("leaves nuka do's step record on a terminal stdout", async () => {
    const stdout = terminalSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "thing-exists", "--args", '{"name":"widget"}'], { rootDir, stdout, stderr });

    expect(exitCode, stderr.text()).toBe(0);
    expect(JSON.parse(stdout.text()).result).toEqual({ id: "t_0001", name: "widget" });
  });
});
