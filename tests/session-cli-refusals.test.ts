import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { encodeLine } from "../src/live/protocol.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the refusal/quiet-cleanup branches of `nuka session
// list/clear/start/stop` (src/cli/session.ts) that the rest of the suite
// never reaches, because every other session test either drives a real live
// daemon (live-session*.test.ts) or a real `do --session` call
// (session.test.ts). Both leave the setup-only failures (bad config, bad
// name, unknown --env) and `stop`'s own no-daemon paths untouched.
//
// The "a name already has a live process" and "connecting to it failed"
// cases below never spawn a daemon: session/lock.ts's own `liveLockOwner`
// only asks whether the pid a lock file names is alive
// (`process.kill(pid, 0)`), so a lock file naming this test process's own
// pid is indistinguishable, to that check, from one a real daemon wrote.
// That is the whole mechanism these tests exploit to stay daemon-free.

function sessionsDir(rootDir: string, environment = "default"): string {
  return path.join(rootDir, ".nukadoko", "cache", "sessions", environment);
}

/** Writes a lock file directly, bypassing `acquireLock` — `sock`, when
 * given, is a live session daemon's own socket path (session/lock.ts's own
 * field); omitted, a lock reads exactly like the one-execution-long lock a
 * plain `nuka do --session` also holds. */
async function writeLockFile(
  rootDir: string,
  environment: string,
  name: string,
  pid: number,
  options: { sock?: string } = {},
): Promise<{ lockPath: string }> {
  const dir = sessionsDir(rootDir, environment);
  await mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, `${name}.lock`);
  await writeFile(
    lockPath,
    `${JSON.stringify({
      pid,
      started_at: new Date().toISOString(),
      ...(options.sock !== undefined ? { sock: options.sock } : {}),
    })}\n`,
  );
  return { lockPath };
}

/** A pid guaranteed to already be dead: spawnSync blocks until the child has
 * exited, so by the time it returns, its pid is free to be reused as a
 * "the process that held this lock is gone" fixture. Same technique
 * session.test.ts's own `deadPid` uses. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (child.pid === undefined) {
    throw new Error("spawnSync did not report a pid");
  }
  return child.pid;
}

describe("nuka session list: setup failure", () => {
  it("propagates a config load failure as exit 1 with a stderr message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "list"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("typo");
    expect(stdout.text()).toBe("");
  });
});

describe("nuka session clear: setup failures", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("session-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("rejects an invalid --env name before touching any session file", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "clear", "--env", "Not Valid!"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).not.toBe("");
    expect(stdout.text()).toBe("");
  });

  it("propagates a config load failure as exit 1 with a stderr message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "clear"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("typo");
  });
});

describe("nuka session start: setup failures and the fast lock refusal", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("session-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("rejects an invalid session name before loading config", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "start", "Not Valid!"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).not.toBe("");
  });

  it("propagates a config load failure as exit 1 with a stderr message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "start", "alice"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("typo");
  });

  it("rejects an unknown --env name", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "start", "alice", "--env", "nope"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).not.toBe("");
  });

  it("refuses when the name already has a live process, naming its pid and the stop command", async () => {
    // `process.pid` (this test process itself) is alive for the whole test
    // run, so `liveLockOwner` reports it as a live owner without any daemon
    // ever having been spawned: see this file's own header.
    await writeLockFile(rootDir, "default", "alice", process.pid);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "start", "alice"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain(`pid ${process.pid}`);
    expect(stderr.text()).toContain("nuka session stop alice");
    expect(stdout.text()).toBe("");
  });
});

describe("nuka session stop: setup failures and every no-daemon outcome", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("session-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("rejects an invalid session name before loading config", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "stop", "Not Valid!"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).not.toBe("");
  });

  it("propagates a config load failure as exit 1 with a stderr message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "stop", "alice"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("typo");
  });

  it("rejects an unknown --env name", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "stop", "alice", "--env", "nope"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).not.toBe("");
  });

  it("succeeds quietly when the name was never live and left no debris", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "stop", "never-started"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toBe("");
  });

  it("cleans up a stale (dead-pid) lock and its socket's own tmp directory, and still succeeds quietly", async () => {
    const sockDir = await mkdtemp(path.join(await realpath("/tmp"), "nk-stale-sock-"));
    const sockPath = path.join(sockDir, "live.sock");
    // A leftover socket *file* (never actually listened on) is exactly what
    // a crashed daemon would leave behind. `liveLockOwner` never dials it,
    // it only reads the lock, so a plain file stands in fine here.
    await writeFile(sockPath, "");
    const { lockPath } = await writeLockFile(rootDir, "default", "alice", deadPid(), { sock: sockPath });

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "stop", "alice"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    await expect(rm(lockPath)).rejects.toThrow();
    await expect(rm(sockPath)).rejects.toThrow();
    // The mkdtemp'd directory itself is gone too, not just the socket file
    // inside it (live/live-sock.ts's own `removeLiveSockDir`) — nothing
    // under the OS's own temp dir should survive reaping a dead session.
    expect(existsSync(sockDir)).toBe(false);
  });

  it("refuses when the lock claims a live pid but names no live session socket", async () => {
    await writeLockFile(rootDir, "default", "alice", process.pid);
    // Deliberately no `sock` field: indistinguishable, by design, from a
    // plain `nuka do --session` execution still in flight
    // (session/lock.ts's own header) — `stop` has nothing to dial and must
    // not touch a lock it does not own.

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "stop", "alice"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("Failed to stop session");
    expect(stderr.text()).toContain(`pid ${process.pid}`);
    expect(stderr.text()).toContain("no live session socket is recorded");
  });

  it("reports a rejection when the live session refuses the stop request", async () => {
    const sockDir = await mkdtemp(path.join(await realpath("/tmp"), "nk-stop-reject-"));
    const sockPath = path.join(sockDir, "live.sock");
    await writeLockFile(rootDir, "default", "alice", process.pid, { sock: sockPath });

    // A minimal stand-in for daemon.ts's own connection handler: read one
    // line, always answer "rejected", enough to exercise
    // runSessionStop's own `response.status === "rejected"` branch without
    // a real daemon behind it.
    const server: Server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\n")) {
          socket.end(encodeLine({ status: "rejected", message: "still mid-execution" }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["session", "stop", "alice"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(1);
      expect(stderr.text()).toContain("did not stop");
      expect(stderr.text()).toContain("still mid-execution");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(sockDir, { recursive: true, force: true });
    }
  });
});
