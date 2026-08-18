import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { isProcessAlive } from "../src/session/lock.js";
import { createCaptureSink, fixture, repoRoot } from "./helpers/fixtures.js";

// Responsibility: `nuka session start`/`do --session`/`stop`'s own round
// trip against a real, detached daemon process (docs/spec.md "Live
// sessions") — the one place this package's tests actually spawn and tear
// down an OS process rather than only calling `runCli` in-process. Every
// `it()` below tracks the daemon pid(s) its own `start()` helper reports
// and `afterEach` force-kills any still alive, on top of whatever cleanup
// that test's own `stop()` call already did — a daemon this file spawns
// must never survive the test that spawned it, whether that test finished
// cleanly or an assertion threw partway through.
//
// This fixture project lives at a *short* path outside this repo's own
// tree entirely (`createLiveSessionProject`, below), not the usual
// `tests/.tmp-fixtures/...` copy every other fixture-backed test uses: a
// live session's own socket path is `cache/sessions/<env>/<name>.sock`
// (docs/spec.md "Live sessions"), and this repository's own absolute path
// is already long enough that appending that onto the ordinary nested copy
// location overruns the OS's ~104-byte `sun_path` limit on a unix socket,
// which fails `listen()` outright rather than merely running slowly.
//
// The counter step (`count`) is what actually proves world persistence: a
// live session's own vocabulary is loaded once, by its own daemon process,
// at `session start` — a plain (non-live) `nuka do` re-discovers the
// vocabulary fresh every call (src/discover/discover-steps.ts's own
// `register({ namespace: randomUUID() })`), which re-imports `count.ts` and
// resets its module-scope counter to 0 every time. Two `do --session`
// calls landing on the same live daemon therefore share one import, hence
// one counter, and a plain `do` sharing this same *test process* does not
// — the distinction this whole feature exists to make observable without a
// browser.

const IDLE_TIMEOUT_SECONDS = 120;

function sessionsDir(rootDir: string): string {
  return path.join(rootDir, "s", "cache", "sessions", "default");
}

/**
 * A fresh copy of tests/fixtures/live-session-project, placed at a short
 * path under `/tmp`'s own realpath (this file's own header explains why)
 * with its own `package.json` (`{"type":"module"}` — nothing under `/tmp`
 * inherits this repo's own from an ancestor the way a normal
 * `tests/.tmp-fixtures/...` copy does), a `node_modules/zod` symlink back
 * to this repo's real dependency (same reason), and `nukadoko-shim.ts`
 * rewritten to point at this repo's `src/index.js` from its *new* location
 * — the committed file's own `../../../src/index.js` is only correct at
 * its committed depth.
 */
async function createLiveSessionProject(): Promise<string> {
  const base = await realpath("/tmp");
  const dir = await mkdtemp(path.join(base, "nk-"));
  await cp(fixture("live-session-project"), dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);

  await mkdir(path.join(dir, "node_modules"), { recursive: true });
  await symlink(path.join(repoRoot, "node_modules", "zod"), path.join(dir, "node_modules", "zod"), "dir");

  const shimPath = path.join(dir, "nukadoko-shim.ts");
  const target = path.join(repoRoot, "src", "index.js");
  let relative = path.relative(dir, target).split(path.sep).join("/");
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  await writeFile(shimPath, `export * from "${relative}";\n`);

  return dir;
}

async function waitUntilDead(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() > deadline) {
      throw new Error(`pid ${pid} did not die within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface DoOutcome {
  readonly exitCode: number;
  readonly record: Record<string, unknown> | undefined;
  readonly stderr: string;
}

describe("nuka session start/stop (live sessions)", () => {
  let rootDir: string;
  let pids: number[];

  beforeEach(async () => {
    rootDir = await createLiveSessionProject();
    pids = [];
  });

  afterEach(async () => {
    // A best-effort SIGKILL backstop for every pid this test's own
    // `start()` reported — covers a daemon a test never got around to
    // stopping (an assertion that threw first) as well as one `stop()`
    // itself already ended cleanly (already dead, so this is a no-op for
    // it). No test in this file may leave a live process behind.
    for (const pid of pids) {
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone between the check and the signal — fine.
        }
      }
    }
    await rm(rootDir, { recursive: true, force: true });
  });

  /** Starts a session and returns its daemon's own pid, tracked for
   * `afterEach`'s cleanup. Asserts `start` itself succeeded — every test
   * below needs a live session to exist before its own assertions begin.
   * `idleTimeoutSeconds` defaults to the long, effectively-never-fires value
   * every other test in this file wants; only the idle-timer re-arm test
   * below passes a short one on purpose. */
  async function start(name: string, idleTimeoutSeconds = IDLE_TIMEOUT_SECONDS): Promise<number> {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["session", "start", name, "--idle-timeout", String(idleTimeoutSeconds)],
      { rootDir, stdout, stderr },
    );
    expect(exitCode, `session start failed: ${stderr.text()}`).toBe(0);
    const [, pidText] = stdout.text().trim().split("\t");
    const pid = Number(pidText);
    expect(Number.isInteger(pid)).toBe(true);
    pids.push(pid);
    return pid;
  }

  async function stop(name: string): Promise<{ exitCode: number; stderr: string }> {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "stop", name], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });
    return { exitCode, stderr: stderr.text() };
  }

  async function doStep(step: string, argsJson: string, session: string | null): Promise<DoOutcome> {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const args = ["do", step, "--args", argsJson, ...(session !== null ? ["--session", session] : [])];
    const exitCode = await runCli(args, { rootDir, stdout, stderr });
    const text = stdout.text();
    return { exitCode, record: text ? JSON.parse(text) : undefined, stderr: stderr.text() };
  }

  it("start, then do twice: the second execution sees the first's world", async () => {
    await start("alice");

    const first = await doStep("count", "{}", "alice");
    const second = await doStep("count", "{}", "alice");

    expect(first.exitCode).toBe(0);
    expect(first.record?.result).toEqual({ count: 1 });
    expect(second.exitCode).toBe(0);
    expect(second.record?.result).toEqual({ count: 2 });
  });

  it("session_execution increases 1, 2, ... across a session's own executions", async () => {
    await start("bob");

    const first = await doStep("count", "{}", "bob");
    const second = await doStep("count", "{}", "bob");

    expect(first.record?.session_execution).toBe(1);
    expect(second.record?.session_execution).toBe(2);
  });

  it("a single `do` with no --session never carries session_execution", async () => {
    const outcome = await doStep("count", "{}", null);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.record?.result).toEqual({ count: 1 });
    expect(outcome.record).not.toHaveProperty("session_execution");
  });

  it("`do --session <name>` with no live session behaves exactly as before: a fresh ctx, no session_execution", async () => {
    // No `start()` call at all — "carol" has never been live.
    const outcome = await doStep("count", "{}", "carol");

    expect(outcome.exitCode).toBe(0);
    expect(outcome.record?.session).toBe("carol");
    expect(outcome.record?.result).toEqual({ count: 1 });
    expect(outcome.record).not.toHaveProperty("session_execution");
  });

  it("a second execution against a busy session is refused, not queued", async () => {
    await start("dana");

    const [slow, fast] = await Promise.all([
      doStep("slow", '{"ms":600}', "dana"),
      (async () => {
        // Started shortly after the slow one, while it is still busy —
        // long enough after to be certain the daemon has already claimed
        // its own busy slot, short enough to still be well inside the
        // slow call's own 600ms.
        await new Promise((resolve) => setTimeout(resolve, 150));
        return doStep("slow", '{"ms":50}', "dana");
      })(),
    ]);

    expect(slow.exitCode).toBe(0);
    expect(slow.record?.status).toBe("ok");
    expect(fast.exitCode).toBe(1);
    expect(fast.record).toBeUndefined();
    expect(fast.stderr).toContain("busy");
  });

  it("socket is 0600 while live, and stop persists storageState to the same .json path", async () => {
    const pid = await start("erin");

    const sockPath = path.join(sessionsDir(rootDir), "erin.sock");
    const sockStats = await stat(sockPath);
    expect(sockStats.mode & 0o777).toBe(0o600);

    const jsonPath = path.join(sessionsDir(rootDir), "erin.json");
    expect(existsSync(jsonPath)).toBe(false);

    // Opens a request context (no browser, no real network call — see
    // features/steps/touch-request.ts) so this session has a real
    // storageState to persist, not just an unused ctx.
    const touched = await doStep("touch-request", "{}", "erin");
    expect(touched.exitCode).toBe(0);

    const stopped = await stop("erin");
    expect(stopped.exitCode, stopped.stderr).toBe(0);

    expect(existsSync(jsonPath)).toBe(true);
    const saved = JSON.parse(await readFile(jsonPath, "utf8"));
    expect(saved).toHaveProperty("cookies");
    expect(saved).toHaveProperty("origins");

    await waitUntilDead(pid);
    expect(existsSync(sockPath)).toBe(false);
  });

  it("list reaps a dead session's lock/socket debris and reports liveness", async () => {
    const pid = await start("finn");

    const liveList = JSON.parse(
      (await (async () => {
        const stdout = createCaptureSink();
        const exitCode = await runCli(["session", "list", "--json"], {
          rootDir,
          stdout,
          stderr: createCaptureSink(),
        });
        expect(exitCode).toBe(0);
        return stdout;
      })()).text(),
    ) as Array<{ name: string; alive: boolean }>;
    expect(liveList.find((entry) => entry.name === "finn")?.alive).toBe(true);

    // A crash, not a clean `stop` — leaves the lock and socket behind with
    // no .json ever written (this session never touched request/page).
    process.kill(pid, "SIGKILL");
    await waitUntilDead(pid);

    const dir = sessionsDir(rootDir);
    expect(existsSync(path.join(dir, "finn.lock"))).toBe(true);

    const stdout = createCaptureSink();
    const exitCode = await runCli(["session", "list", "--json"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    const list = JSON.parse(stdout.text()) as Array<{ name: string }>;

    // No .json was ever written for "finn", so once its dead lock is
    // reaped there is nothing left to call a session at all (session/
    // manage.ts's own header: a dead, .json-less lock was never itself a
    // session `list` reports).
    expect(list.find((entry) => entry.name === "finn")).toBeUndefined();
    expect(existsSync(path.join(dir, "finn.lock"))).toBe(false);
    expect(existsSync(path.join(dir, "finn.sock"))).toBe(false);
  });

  it("says which world each --session execution ran in, on stderr", async () => {
    // Fresh: "gale" has never been live, so this is the pre-existing path
    // unchanged, just now naming itself on stderr too.
    const fresh = await doStep("count", "{}", "gale");
    expect(fresh.exitCode).toBe(0);
    expect(fresh.stderr).toContain(
      'Session "gale" is not live; running this step in a fresh browser, from its saved state',
    );

    // Delegated: names the live session's own pid and this execution's
    // position in its own sequence, matching `session_execution` on the
    // record itself rather than a separate count.
    const pid = await start("gale-live");
    const delegated = await doStep("count", "{}", "gale-live");
    expect(delegated.exitCode).toBe(0);
    expect(delegated.record?.session_execution).toBe(1);
    expect(delegated.stderr).toContain(`Session "gale-live" is live (pid ${pid})`);
    expect(delegated.stderr).toContain("execution #1");

    // Debris: a crash (not a clean `stop`) leaves the socket behind: the
    // next --session call against that name says it found and removed
    // that debris, on top of (not instead of) the fresh-ctx line above.
    process.kill(pid, "SIGKILL");
    await waitUntilDead(pid);
    const afterCrash = await doStep("count", "{}", "gale-live");
    expect(afterCrash.exitCode).toBe(0);
    expect(afterCrash.stderr).toContain(
      "gale-live\"'s socket is left over from a session that is no longer live",
    );
    expect(afterCrash.stderr).toContain(
      'Session "gale-live" is not live; running this step in a fresh browser, from its saved state',
    );
  });

  it("a refused request still re-arms the idle timer, not only a successful one", async () => {
    const idleTimeoutSeconds = 1;
    const pid = await start("gwen", idleTimeoutSeconds);

    // Sent partway through the original idle window, and refused (unknown
    // step) rather than executed. If a refusal did not re-arm the timer,
    // the *original* deadline (1s after `start`) would already have
    // passed by the time the check below runs.
    await new Promise((resolve) => setTimeout(resolve, idleTimeoutSeconds * 1000 * 0.7));
    const rejected = await doStep("no-such-step", "{}", "gwen");
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("Unknown step");

    await new Promise((resolve) => setTimeout(resolve, idleTimeoutSeconds * 1000 * 0.6));
    expect(isProcessAlive(pid)).toBe(true);

    // Left genuinely idle from here, the session still times out on its
    // own — this fix re-arms the countdown, it does not disable it.
    await waitUntilDead(pid, idleTimeoutSeconds * 1000 + 5000);
  });
});
