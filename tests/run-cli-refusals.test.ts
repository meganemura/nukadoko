import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { sessionLockPath, sessionFilePath } from "../src/session/paths.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run`'s own setup-phase refusals (src/cli/run.ts)
// that run.test.ts and its siblings never reach. Every one of these returns
// before `selectPickles` is ever called, so the feature argument itself is
// never read; none of them needs a project whose feature file actually
// parses. `--session`'s lock is acquired even earlier than step discovery,
// which is why a lock conflict and an invalid session name are grouped
// here alongside the discovery failure and the unknown-environment case,
// all four reachable with the same lightweight fixture.

describe("nuka run: setup-phase refusals reachable before any pickle is selected", () => {
  it("rejects an unknown --env name", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/whatever.feature", "--env", "no-such-env"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("no-such-env");
  });

  it("rejects an invalid --session name", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["run", "features/whatever.feature", "--session", "Not Valid!"],
      { rootDir: fixture("basic-project"), stdout, stderr },
    );

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).not.toBe("");
  });

  it("refuses when the named session's lock is held by a live process", async () => {
    const rootDir = await copyFixtureToTempDir("basic-project");
    try {
      // `process.pid` (this test process itself) is alive for the whole
      // test run, so `acquireLock`'s own `liveLockOwner` check reports a
      // conflict without any other process ever having touched this lock:
      // same technique as session-cli-refusals.test.ts's own header.
      const lockPath = sessionLockPath(rootDir, ".nukadoko", "default", "busy");
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);

      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(
        ["run", "features/whatever.feature", "--session", "busy"],
        { rootDir, stdout, stderr },
      );

      expect(exitCode).toBe(1);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toContain(`pid ${process.pid}`);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("propagates a step discovery failure (a broken glue file) as exit 1 with a stderr message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/whatever.feature"], {
      rootDir: fixture("discover-import-failure-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("require is not defined");
  });
});

describe("nuka run --session: a malformed session file fails mid-run, not setup", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-session-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes zero scenario records and reports the malformed session on stderr", async () => {
    const sessionPath = sessionFilePath(rootDir, ".nukadoko", "default", "corrupt");
    await mkdir(path.dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, "{not json");

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["run", "features/session-flow.feature", "--session", "corrupt"],
      { rootDir, stdout, stderr },
    );

    // Unlike every setup-phase refusal above, this fails *during* the
    // pickle loop (BeforeAll has already run by the time a scenario's own
    // storageState read fails). cli/run.ts's own header explains why that
    // makes this a scenario-record-less failure rather than a `return 1`
    // straight out of setup: no scenario record exists to say what
    // happened, but the run itself still ends non-zero.
    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("corrupt");
  });
});
