import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: cli/do.ts's own delegateToLiveSession, for the one branch
// tests/session-cli-refusals.test.ts's equivalent case never reaches (that
// file drives `nuka session stop`, a different call site into the same
// sendLiveRequest). `liveLockOwner` only asks whether the pid a lock file
// names is alive (`process.kill(pid, 0)`), so a lock file naming this test
// process's own pid is indistinguishable, to that check, from one a real
// daemon wrote (the same technique session-cli-refusals.test.ts already
// uses to stay daemon-free). The `.sock` path is a plain file, never a
// listening socket, so connecting to it fails the way a crashed daemon's
// leftover socket file would.

function sessionsDir(rootDir: string): string {
  return path.join(rootDir, ".nukadoko", "cache", "sessions", "default");
}

describe("nuka do --session: a live lock whose socket does not answer", () => {
  it("reports the transport failure on stderr, naming the session and pid, and writes no step record", async () => {
    const rootDir = await copyFixtureToTempDir("basic-project");
    try {
      const dir = sessionsDir(rootDir);
      await mkdir(dir, { recursive: true });
      const lockPath = path.join(dir, "gale.lock");
      const sockPath = path.join(dir, "gale.sock");
      await writeFile(
        lockPath,
        `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`,
      );
      // A plain file, not a listening unix socket: `existsSync(sockPath)`
      // reads true (do.ts's own "a live owner with a socket" branch), but
      // `sendLiveRequest` must still fail to connect.
      await writeFile(sockPath, "");

      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(
        ["do", "list-projects", "--args", "{}", "--session", "gale"],
        { rootDir, stdout, stderr },
      );

      expect(exitCode).toBe(1);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toContain(`Session "gale" is live (pid ${process.pid}) but connecting to it failed`);
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
