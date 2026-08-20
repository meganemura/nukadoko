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

async function writeLockFile(
  rootDir: string,
  environment: string,
  name: string,
  pid: number,
): Promise<{ lockPath: string; sockPath: string }> {
  const dir = sessionsDir(rootDir, environment);
  await mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, `${name}.lock`);
  await writeFile(lockPath, `${JSON.stringify({ pid, started_at: new Date().toISOString() })}\n`);
  return { lockPath, sockPath: path.join(dir, `${name}.sock`) };
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

/**
 * A minimal project at a *short* path under `/tmp`'s own realpath, not the
 * usual nested `tests/.tmp-fixtures/...` copy: a live session's own socket
 * path is `cache/sessions/<env>/<name>.sock`, and appending that to this
 * repository's own (long) absolute path overruns the OS's ~104-byte
 * `sun_path` limit on a unix socket, so `listen()` fails outright rather
 * than merely running slowly (same reasoning as live-session.test.ts's own
 * `createLiveSessionProject`, which this mirrors at a much smaller scale:
 * `runSessionStop` never loads step files, so there is nothing here for
 * `defineConfig`/a shim/a `featuresDir` to serve).
 */
async function createShortPathProject(): Promise<string> {
  const base = await realpath("/tmp");
  const dir = await mkdtemp(path.join(base, "nk-"));
  // Without a `"type": "module"` package.json, tsx's own CJS interop
  // double-wraps a plain `export default {}` into `{ default: {} }`,
  // which the config schema then rejects as an unknown "default" key
  // (discovered empirically while writing this fixture). Every other
  // fixture in this repo avoids the question entirely by inheriting
  // this repository's own package.json from an ancestor directory, which
  // a short `/tmp` path deliberately does not have.
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  await writeFile(path.join(dir, "nukadoko.config.ts"), "export default {};\n");
  return dir;
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

  it("cleans up a stale (dead-pid) lock and its socket, and still succeeds quietly", async () => {
    const { lockPath, sockPath } = await writeLockFile(rootDir, "default", "alice", deadPid());
    // A leftover socket *file* (never actually listened on) is exactly what
    // a crashed daemon would leave behind. `liveLockOwner` never dials it,
    // it only reads the lock, so a plain file stands in fine here.
    await writeFile(sockPath, "");

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
  });

  it("reports a transport failure when the lock claims a live pid but no socket answers", async () => {
    await writeLockFile(rootDir, "default", "alice", process.pid);
    // Deliberately no socket at all: `sendLiveRequest` must fail to connect.

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
  });

  it("reports a rejection when the live session refuses the stop request", async () => {
    // A real listening unix socket, unlike every other case in this file:
    // needs the short-path project (this file's own
    // `createShortPathProject` header) or `listen()` itself fails.
    const shortRootDir = await createShortPathProject();
    try {
      const { sockPath } = await writeLockFile(shortRootDir, "default", "alice", process.pid);

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
          rootDir: shortRootDir,
          stdout,
          stderr,
        });

        expect(exitCode).toBe(1);
        expect(stderr.text()).toContain("did not stop");
        expect(stderr.text()).toContain("still mid-execution");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await removeTempDir(shortRootDir);
    }
  });
});
