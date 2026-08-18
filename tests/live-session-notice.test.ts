import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { sessionLockPath, sessionSockPath } from "../src/session/paths.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run`/`nuka accept` reporting a live session found at
// start (docs/spec.md "Live sessions"), never refusing on its account. A
// live session's own daemon is never actually spawned here — that is
// tests/live-session.test.ts's own, much heavier, job — a lock file
// carrying this test process's own (genuinely alive) pid, plus a socket
// file beside it, is exactly what `findLiveSessions`
// (src/live/live-session-notice.ts) checks for, so faking those two files
// is enough to exercise the detection without a real daemon.

const STATE_DIR = ".nukadoko";

async function writeLiveSession(
  rootDir: string,
  environment: string,
  name: string,
  options: { withSocket: boolean; pid?: number },
): Promise<void> {
  const lockPath = sessionLockPath(rootDir, STATE_DIR, environment, name);
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(
    lockPath,
    `${JSON.stringify({ pid: options.pid ?? process.pid, started_at: new Date().toISOString() })}\n`,
  );
  if (options.withSocket) {
    await writeFile(sessionSockPath(rootDir, STATE_DIR, environment, name), "");
  }
}

describe("live session notice (nuka run / nuka accept)", () => {
  let rootDir: string;

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  describe("nuka run", () => {
    beforeEach(async () => {
      rootDir = await copyFixtureToTempDir("run-project");
    });

    it("stays silent when no session is live", async () => {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "features/passing.feature"], { rootDir, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stderr.text()).not.toContain("Live session");
    });

    it("reports one live session in the default environment, with no --env in the stop command", async () => {
      await writeLiveSession(rootDir, "default", "alice", { withSocket: true });

      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "features/passing.feature"], { rootDir, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stderr.text()).toContain('Live session "alice" (environment default) is still open.');
      expect(stderr.text()).toContain("Stop it with `nuka session stop alice`.");
    });

    it("reports every live session, across every environment", async () => {
      await writeLiveSession(rootDir, "default", "alice", { withSocket: true });
      await writeLiveSession(rootDir, "staging", "bob", { withSocket: true });

      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "features/passing.feature"], { rootDir, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stderr.text()).toContain('Live session "alice" (environment default) is still open.');
      expect(stderr.text()).toContain('Live session "bob" (environment staging) is still open.');
      expect(stderr.text()).toContain("Stop it with `nuka session stop bob --env staging`.");
    });

    it("ignores a lock with no socket beside it (a plain, non-live `do --session` lock)", async () => {
      await writeLiveSession(rootDir, "default", "carol", { withSocket: false });

      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "features/passing.feature"], { rootDir, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stderr.text()).not.toContain("Live session");
    });

    it("ignores a stale lock (dead pid) even with a socket beside it", async () => {
      // A pid this OS will never have assigned to a real process during
      // this test run — `liveLockOwner`'s own `isProcessAlive` treats ESRCH
      // as dead, the same stale-lock rule every other session command
      // already follows.
      await writeLiveSession(rootDir, "default", "dave", { withSocket: true, pid: 2_147_483_647 });

      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "features/passing.feature"], { rootDir, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stderr.text()).not.toContain("Live session");
    });
  });

  describe("nuka accept", () => {
    beforeEach(async () => {
      rootDir = await copyFixtureToTempDir("accept-project");
    });

    it("stays silent when no session is live", async () => {
      await initGitRepo(rootDir);
      const runExit = await runCli(["run", "features/greeting.feature"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      });
      expect(runExit).toBe(0);

      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const acceptExit = await runCli(["accept", "features/greeting.feature"], { rootDir, stdout, stderr });

      expect(acceptExit).toBe(0);
      expect(stderr.text()).not.toContain("Live session");
    });

    it("reports a live session without refusing a sign-off that otherwise qualifies", async () => {
      await initGitRepo(rootDir);
      const runExit = await runCli(["run", "features/greeting.feature"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      });
      expect(runExit).toBe(0);

      await writeLiveSession(rootDir, "default", "alice", { withSocket: true });

      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const acceptExit = await runCli(["accept", "features/greeting.feature"], { rootDir, stdout, stderr });

      expect(acceptExit).toBe(0);
      expect(stdout.text().trim().length).toBeGreaterThan(0);
      expect(stderr.text()).toContain('Live session "alice" (environment default) is still open.');
    });
  });
});
