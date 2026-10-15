import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

// A step that returns a Date or a bigint has to survive the real write
// path: the stored form, JSON.stringify into the step record, accept, then
// tend. An empty object in the record is the bug. An ISO string or a
// decimal string that tend then rejects is the same bug one step later.

interface Report {
  errors: { code: string; message: string; step?: string }[];
}

describe("a frozen Date result", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("date-stamp-project");
    await initGitRepo(rootDir);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("records the ISO string and tend accepts the sign-off", async () => {
    const runExit = await runCli(["run", "elsewhere/stamp.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    const acceptStdout = createCaptureSink();
    const acceptExit = await runCli(["accept", "elsewhere/stamp.feature"], {
      rootDir,
      stdout: acceptStdout,
      stderr: createCaptureSink(),
    });
    expect(acceptExit).toBe(0);
    const recordPath = acceptStdout.text().trim();
    const record = await readFile(path.join(rootDir, recordPath), "utf8");
    expect(record).toContain('"createdAt": "2026-01-02T03:04:05.000Z"');
    expect(record).not.toContain('"createdAt": {}');

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const tendExit = await runCli(["tend", "--json"], { rootDir, stdout, stderr });
    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text()) as Report;
    expect(report.errors.filter((error) => error.code === "signoff-result-invalid")).toEqual([]);
    expect(tendExit).toBe(0);
  });

  it("records a bigint as its decimal string and tend accepts the sign-off", async () => {
    const runExit = await runCli(["run", "elsewhere/atoms.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    const acceptStdout = createCaptureSink();
    const acceptExit = await runCli(["accept", "elsewhere/atoms.feature"], {
      rootDir,
      stdout: acceptStdout,
      stderr: createCaptureSink(),
    });
    expect(acceptExit).toBe(0);
    const record = await readFile(path.join(rootDir, acceptStdout.text().trim()), "utf8");
    expect(record).toContain('"total": "123456789012345678901234567890"');
    expect(record).toContain('"coerced": "123456789012345678901234567890"');

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const tendExit = await runCli(["tend", "--json"], { rootDir, stdout, stderr });
    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text()) as Report;
    expect(report.errors).toEqual([]);
    expect(tendExit).toBe(0);
  });
});
