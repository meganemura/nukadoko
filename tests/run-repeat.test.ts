import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run --repeat <n>`: every selected scenario runs n
// times in one invocation, each execution its own scenario record under
// the one run_id, the summary counts executions, and a scenario that
// failed at least once gets a `repeat` line after the failed list. The
// concurrent case checks that a worker repeats its own files.

function records(stdout: string): { feature: string; line: number; status: string; run_id: string }[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("nuka run --repeat", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("runs the selection n times under one run_id and counts executions in the summary", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/greeting.feature", "--repeat", "3"], { rootDir, stdout, stderr });
    expect(exitCode, stderr.text()).toBe(0);

    const seen = records(stdout.text());
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((record) => record.run_id)).size).toBe(1);
    expect(seen.every((record) => record.status === "passed")).toBe(true);
    expect(stderr.text()).toMatch(/^3 scenarios: 3 passed, 0 failed/m);
    // Boundary lines number executions across every pass.
    expect(stderr.text()).toContain("scenario 3/3");
    // Every pass green: nothing to tally.
    expect(stderr.text()).not.toContain("repeat  ");
  });

  it("tallies a scenario that failed at least once, after the failed list", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/failing.feature", "--repeat", "2"], { rootDir, stdout, stderr });
    expect(exitCode).toBe(1);

    const seen = records(stdout.text());
    expect(seen).toHaveLength(2);
    const [first] = seen;
    expect(stderr.text()).toMatch(/^2 scenarios: 0 passed, 2 failed/m);
    expect(stderr.text()).toMatch(new RegExp(`^repeat  ${first!.feature}:${first!.line}  .*  0 of 2 passed$`, "m"));
    // The repeat line follows the failed list, never precedes it.
    expect(stderr.text().indexOf("failed  ")).toBeLessThan(stderr.text().indexOf("repeat  "));
  });

  it("emits one testCase per execution into the messages stream", async () => {
    const exitCode = await runCli(["run", "features/greeting.feature", "--repeat", "3"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    const stream = await readFile(path.join(rootDir, ".nukadoko", "export", "messages.ndjson"), "utf8");
    const envelopes = stream
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(envelopes.filter((envelope) => "pickle" in envelope)).toHaveLength(1);
    expect(envelopes.filter((envelope) => "testCase" in envelope)).toHaveLength(3);
    expect(envelopes.filter((envelope) => "testCaseFinished" in envelope)).toHaveLength(3);
  });

  it("refuses anything but a whole number of 1 or more", async () => {
    for (const value of ["0", "1.5", "abc"]) {
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "features/greeting.feature", "--repeat", value], {
        rootDir,
        stdout: createCaptureSink(),
        stderr,
      });
      expect(exitCode, value).toBe(1);
      expect(stderr.text()).toContain("--repeat must be a whole number of 1 or more");
    }
  });
});

describe("nuka run --repeat with --concurrency", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-concurrency-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("has each worker repeat its own files, under one run_id", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/basic/", "--concurrency", "2", "--repeat", "2"], {
      rootDir,
      stdout,
      stderr,
    });
    expect(exitCode, stderr.text()).toBe(0);
    const seen = records(stdout.text());
    expect(seen).toHaveLength(4);
    expect(new Set(seen.map((record) => record.run_id)).size).toBe(1);
    expect(seen.filter((record) => record.feature === "features/basic/a.feature")).toHaveLength(2);
    expect(seen.filter((record) => record.feature === "features/basic/b.feature")).toHaveLength(2);
    expect(stderr.text()).toMatch(/^4 scenarios: 4 passed, 0 failed/m);
    expect(stderr.text()).toContain("scenario 4/4");
  });

  it("tallies across workers", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      'import { defineConfig } from "./nukadoko-shim.js";\n\nexport default defineConfig({});\n',
    );
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/failure/", "--concurrency", "2", "--repeat", "2", "--quiet"], {
      rootDir,
      stdout,
      stderr,
    });
    expect(exitCode).toBe(1);
    expect(stderr.text()).toMatch(/^repeat  features\/failure\/.*  0 of 2 passed$/m);
  });
});
