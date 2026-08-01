import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `--session`'s request-path round trip, the setup-phase
// failures this task's spec adds to `do` (invalid name, malformed session
// file, lock conflict), and `nuka session list`/`clear`. The browser-path
// round trip lives in its own file (session-browser.test.ts), same
// separation as create-context.test.ts (node:http only) vs
// browser-evidence.test.ts (chromium) for the pre-existing evidence tests.

/** A server responding to /set-cookie (Set-Cookie: sid=abc123) and /whoami
 * (echoes the Cookie header it received, or null) — session-project's
 * login.ts / whoami.ts steps hit these. */
function startTestServer(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/set-cookie") {
        res.writeHead(200, {
          "set-cookie": "sid=abc123; Path=/",
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/whoami") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}` });
    });
  });
}

/** A pid guaranteed to already be dead: spawnSync blocks until the child
 * has exited, so by the time it returns, its pid is free to be reused as a
 * "the process that held this lock is gone" fixture. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (child.pid === undefined) {
    throw new Error("spawnSync did not report a pid");
  }
  return child.pid;
}

function sessionsDir(rootDir: string): string {
  return path.join(rootDir, ".nukadoko", "sessions", "default");
}

describe("nuka do --session (request path)", () => {
  let server: Server;
  let baseURL: string;
  let rootDir: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startTestServer());
    rootDir = await copyFixtureToTempDir("session-project");
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        `export default defineConfig({ baseURL: "${baseURL}" });`,
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  it("round-trips a cookie across two `do` calls sharing a session, and saves the file at 0600", async () => {
    const loginStdout = createCaptureSink();
    const loginExit = await runCli(
      ["do", "login", "--args", "{}", "--session", "s1"],
      { rootDir, stdout: loginStdout, stderr: createCaptureSink() },
    );
    expect(loginExit).toBe(0);
    const loginReceipt = JSON.parse(loginStdout.text());
    expect(loginReceipt.session).toBe("s1");

    const sessionFile = path.join(sessionsDir(rootDir), "s1.json");
    expect(existsSync(sessionFile)).toBe(true);
    const stats = await stat(sessionFile);
    expect(stats.mode & 0o777).toBe(0o600);

    const whoamiStdout = createCaptureSink();
    const whoamiExit = await runCli(
      ["do", "whoami", "--args", "{}", "--session", "s1"],
      { rootDir, stdout: whoamiStdout, stderr: createCaptureSink() },
    );
    expect(whoamiExit).toBe(0);
    const whoamiReceipt = JSON.parse(whoamiStdout.text());
    expect(whoamiReceipt.result.cookie).toContain("sid=abc123");
  });

  it("records the given --session name on the receipt", async () => {
    const stdout = createCaptureSink();
    await runCli(["do", "login", "--args", "{}", "--session", "s1"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(JSON.parse(stdout.text()).session).toBe("s1");
  });

  it("receipt.session is null when --session is omitted", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "whoami", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text()).session).toBeNull();
  });

  it("does not create a sessions directory when --session is never used", async () => {
    const exitCode = await runCli(["do", "whoami", "--args", "{}"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(rootDir, ".nukadoko", "sessions"))).toBe(false);
  });

  it("ignores an existing session's file when --session is omitted (clean start)", async () => {
    // Establish session "s1" with a real cookie first.
    await runCli(["do", "login", "--args", "{}", "--session", "s1"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(existsSync(path.join(sessionsDir(rootDir), "s1.json"))).toBe(true);

    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "whoami", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text()).result.cookie).toBeNull();
  });

  it("rejects an invalid session name in setup, before any state directory exists", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["do", "whoami", "--args", "{}", "--session", "../x"],
      { rootDir, stdout: createCaptureSink(), stderr },
    );
    expect(exitCode).toBe(1);
    expect(stderr.text()).not.toBe("");
    expect(existsSync(path.join(rootDir, ".nukadoko"))).toBe(false);
  });

  it("exits 1 without writing a receipt when the session's lock is held by a live process", async () => {
    const lockPath = path.join(sessionsDir(rootDir), "s2.lock");
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
    );

    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["do", "whoami", "--args", "{}", "--session", "s2"],
      { rootDir, stdout: createCaptureSink(), stderr },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("s2");
    expect(existsSync(path.join(rootDir, ".nukadoko", "receipts"))).toBe(false);
  });

  it("runs (and releases the lock) when the session's lock belongs to a dead pid", async () => {
    const lockPath = path.join(sessionsDir(rootDir), "s3.lock");
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: deadPid(), started_at: new Date().toISOString() }),
    );

    const stdout = createCaptureSink();
    const exitCode = await runCli(
      ["do", "whoami", "--args", "{}", "--session", "s3"],
      { rootDir, stdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text()).session).toBe("s3");
    // Released at the end of the run, per this task's spec (decision 4).
    expect(existsSync(lockPath)).toBe(false);
  });

  it("fails setup (exit 1, no receipt) when the session file is malformed JSON", async () => {
    const sessionFile = path.join(sessionsDir(rootDir), "s4.json");
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, "{not json");

    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["do", "whoami", "--args", "{}", "--session", "s4"],
      { rootDir, stdout: createCaptureSink(), stderr },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("s4");
    expect(existsSync(path.join(rootDir, ".nukadoko", "receipts"))).toBe(false);
  });
});

describe("nuka session list/clear", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-session-cli-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function writeFakeSession(name: string): Promise<void> {
    const dir = sessionsDir(rootDir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${name}.json`), JSON.stringify({ cookies: [], origins: [] }));
  }

  it("lists sessions as JSON: environment, name, updated_at", async () => {
    await writeFakeSession("alpha");
    await writeFakeSession("beta");

    const stdout = createCaptureSink();
    const exitCode = await runCli(["session", "list", "--json"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const list = JSON.parse(stdout.text());
    expect(list).toHaveLength(2);
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ environment: "default", name: "alpha" }),
        expect.objectContaining({ environment: "default", name: "beta" }),
      ]),
    );
    for (const entry of list) {
      expect(() => new Date(entry.updated_at as string).toISOString()).not.toThrow();
    }
  });

  it("lists zero sessions with exit 0", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["session", "list", "--json"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual([]);
  });

  it("prints one line per session in human-readable mode", async () => {
    await writeFakeSession("alpha");
    const stdout = createCaptureSink();
    const exitCode = await runCli(["session", "list"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    expect(stdout.text().trim().split("\n")).toHaveLength(1);
    expect(stdout.text()).toContain("alpha");
  });

  it("clears a named session", async () => {
    await writeFakeSession("alpha");
    const exitCode = await runCli(["session", "clear", "alpha"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(sessionsDir(rootDir), "alpha.json"))).toBe(false);
  });

  it("exits 1 clearing a session that does not exist", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "clear", "no-such-session"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });
    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("no-such-session");
  });

  it("refuses to clear a session whose lock is held by a live process", async () => {
    await writeFakeSession("alpha");
    await writeFile(
      path.join(sessionsDir(rootDir), "alpha.lock"),
      JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
    );

    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "clear", "alpha"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(existsSync(path.join(sessionsDir(rootDir), "alpha.json"))).toBe(true);
  });

  it("clears every session for the default environment when no name is given", async () => {
    await writeFakeSession("alpha");
    await writeFakeSession("beta");

    const exitCode = await runCli(["session", "clear"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    expect(existsSync(path.join(sessionsDir(rootDir), "alpha.json"))).toBe(false);
    expect(existsSync(path.join(sessionsDir(rootDir), "beta.json"))).toBe(false);
  });

  it("deletes nothing when clearing all sessions and any lock is live (no partial deletes)", async () => {
    await writeFakeSession("alpha");
    await writeFakeSession("beta");
    await writeFile(
      path.join(sessionsDir(rootDir), "alpha.lock"),
      JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
    );

    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "clear"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(existsSync(path.join(sessionsDir(rootDir), "alpha.json"))).toBe(true);
    expect(existsSync(path.join(sessionsDir(rootDir), "beta.json"))).toBe(true);
  });
});
