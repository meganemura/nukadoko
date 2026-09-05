import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a `--concurrency <n>` run says which scenario is running,
// not only which one finished. The parent hears from a worker only when a
// scenario ends, so before this a hung scenario left a log whose last line
// named the scenario before it; a project chasing a hang across six CI runs
// had to diff the scenario names in the log against a local run to find the
// one that never appeared. The serial path already writes its boundary line
// at the start, so nothing changes there.

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

describe("nuka run --concurrency progress", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-concurrency-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes a start line per scenario, naming the worker, before the finishing line", async () => {
    const stderr = createCaptureSink();
    expect(
      await runCli(["run", "features/basic/", "--concurrency", "2"], { rootDir, stdout: createCaptureSink(), stderr }),
      stderr.text(),
    ).toBe(0);

    const text = stderr.text();
    const starts = lines(text).filter((line) => line.startsWith("scenario start "));
    expect(starts).toHaveLength(2);
    for (const feature of ["features/basic/a.feature", "features/basic/b.feature"]) {
      const start = starts.find((line) => line.includes(feature));
      expect(start, `no start line for ${feature} in:\n${text}`).toBeDefined();
      expect(start).toMatch(/^scenario start {2}worker [12] {2}features\/basic\/[ab]\.feature:3 {2}\S/);
    }
    // Both workers were named, since two files went to two workers.
    expect(new Set(starts.map((line) => line.match(/worker (\d+)/)![1]))).toEqual(new Set(["1", "2"]));
  });

  it("orders each scenario's start line before its own finishing line", async () => {
    const stderr = createCaptureSink();
    expect(
      await runCli(["run", "features/basic/a.feature", "features/basic/b.feature", "--concurrency", "2"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr,
      }),
    ).toBe(0);

    const all = lines(stderr.text());
    for (const feature of ["features/basic/a.feature", "features/basic/b.feature"]) {
      const startAt = all.findIndex((line) => line.startsWith("scenario start ") && line.includes(feature));
      const doneAt = all.findIndex((line) => /^scenario \d+\/\d+ /.test(line) && line.includes(feature));
      expect(startAt, feature).toBeGreaterThanOrEqual(0);
      expect(doneAt, feature).toBeGreaterThanOrEqual(0);
      expect(startAt).toBeLessThan(doneAt);
    }
  });

  it("--quiet suppresses the start line, as it does the finishing line", async () => {
    const stderr = createCaptureSink();
    expect(
      await runCli(["run", "features/basic/", "--concurrency", "2", "--quiet"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr,
      }),
    ).toBe(0);
    expect(stderr.text()).not.toContain("scenario start ");
    expect(stderr.text()).toMatch(/^2 scenarios: 2 passed, 0 failed/m);
  });

  it("writes no start line at concurrency 1, where the boundary line is already written at the start", async () => {
    const stderr = createCaptureSink();
    expect(
      await runCli(["run", "features/basic/"], { rootDir, stdout: createCaptureSink(), stderr }),
    ).toBe(0);
    expect(stderr.text()).not.toContain("scenario start ");
    expect(stderr.text()).toMatch(/^scenario 1\/2 {2}features\/basic\//m);
  });
});
