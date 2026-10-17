import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { constants } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  removeTempDir,
  repoRoot,
  sourceNodeArgs,
} from "./helpers/fixtures.js";

// Responsibility: SIGINT, SIGTERM, and SIGHUP during `nuka run` or `nuka
// do` still run fixture teardown, in every worker under `--concurrency`
// too, and so does a SIGKILL of the concurrent parent, before or after it
// forwarded a signal. A normal finish still tears down as well. A worker's
// stdin reads as empty, as a terminal-less run's stdin should.
//
// The signal cases spawn a real process. Delivering the signal to this
// vitest process would tear the runner down, so the child is `src/cli.ts`
// under nukadoko's own loader with the fixture project as its cwd. The child is killed if a
// case ends while it is still alive.
//
// Every `nuka run` here passes `--no-check`. These cases wait on fixture
// setup and process exit with fixed deadlines, and the static check's extra
// step discovery before the workers start is not what they cover.

interface LogEntry {
  readonly fixture: string;
  readonly phase: string;
  readonly outcome?: string;
}

const children: ChildProcess[] = [];

async function readLog(rootDir: string): Promise<LogEntry[]> {
  try {
    const text = await readFile(path.join(rootDir, "fixture-log.jsonl"), "utf8");
    return text
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LogEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const workerPids: number[] = [];

const WORKER_DISCONNECTED_LINE =
  "Code in this worker closed its IPC channel to the parent while the parent was still running " +
  "(process.disconnect()). nukadoko reads a closed channel as the parent ending, so this worker " +
  "tears its fixtures down and stops.";

// The child is the CLI process itself, with no wrapper process in between:
// a SIGKILL to a wrapper would miss the process that spawned the workers.
function spawnNuka(rootDir: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const child = spawn(process.execPath, [...sourceNodeArgs, path.join(repoRoot, "src", "cli.ts"), ...args], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  children.push(child);
  return child;
}

async function waitForSetups(rootDir: string, perFixture = 1): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const setups = (await readLog(rootDir)).filter((entry) => entry.phase === "setup");
    const count = (fixture: string): number => setups.filter((entry) => entry.fixture === fixture).length;
    if (count("tenant") >= perFixture && count("ledger") >= perFixture) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fixture setup was not logged within 20s:\n${JSON.stringify(await readLog(rootDir))}`);
}

async function readFixturePids(rootDir: string): Promise<number[]> {
  const text = await readFile(path.join(rootDir, "fixture-pids.txt"), "utf8");
  const pids = text.trim().split("\n").map(Number);
  workerPids.push(...pids);
  return pids;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForGone(pids: readonly number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pids.some(isAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return pids.filter(isAlive);
}

function collect(stream: NodeJS.ReadableStream | null): () => string {
  let text = "";
  stream?.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return () => text;
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`child ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function stoppedBy(expected: NodeJS.Signals, code: number | null, signal: NodeJS.Signals | null): boolean {
  return code === 128 + constants.signals[expected] || signal === expected;
}

describe("fixture teardown when nuka run or nuka do is signaled", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("signal-teardown-project");
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    children.length = 0;
    for (const pid of workerPids) {
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
    }
    workerPids.length = 0;
    await removeTempDir(rootDir);
  });

  it("tears both scopes down when nuka run finishes", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/finish.feature"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    const log = await readLog(rootDir);
    expect(log.filter((entry) => entry.phase === "teardown").map((entry) => entry.fixture)).toEqual([
      "tenant",
      "ledger",
    ]);
    expect(log.find((entry) => entry.fixture === "tenant" && entry.phase === "teardown")?.outcome).toBe("passed");
    expect(log.find((entry) => entry.fixture === "ledger" && entry.phase === "teardown")?.outcome).toBe("passed");
    expect(log.some((entry) => entry.phase === "cleanup")).toBe(true);
  });

  it("tears both scopes down when nuka do finishes", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "finish-fixture", "--args", "{}"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    const log = await readLog(rootDir);
    const teardowns = log.filter((entry) => entry.phase === "teardown");
    expect(teardowns.map((entry) => entry.fixture)).toEqual(["tenant", "ledger"]);
    expect(teardowns.every((entry) => entry.outcome === "passed")).toBe(true);
  });

  it("tears every worker's fixtures down when nuka run --concurrency 2 is killed with SIGKILL", async () => {
    const child = spawnNuka(rootDir, [
      "run",
      "--no-check",
      "features/hold.feature",
      "features/hold-again.feature",
      "--quiet",
      "--concurrency",
      "2",
    ]);
    await waitForSetups(rootDir, 2);
    const pids = await readFixturePids(rootDir);
    child.kill("SIGKILL");
    await waitForClose(child, 5_000);

    expect(await waitForGone(pids, 10_000), "worker processes still alive").toEqual([]);
    const teardowns = (await readLog(rootDir)).filter((entry) => entry.phase === "teardown");
    expect(teardowns.map((entry) => `${entry.fixture}:${entry.outcome}`).sort()).toEqual([
      "ledger:failed",
      "ledger:failed",
      "tenant:failed",
      "tenant:failed",
    ]);
  }, 40_000);

  it("tears every worker's fixtures down when they write to stdout and stderr after the parent is killed with SIGKILL", async () => {
    const child = spawnNuka(
      rootDir,
      ["run", "--no-check", "features/hold.feature", "features/hold-again.feature", "--quiet", "--concurrency", "2"],
      { ...process.env, TEARDOWN_WRITES: "1" },
    );
    await waitForSetups(rootDir, 2);
    const pids = await readFixturePids(rootDir);
    child.kill("SIGKILL");
    await waitForClose(child, 5_000);

    expect(await waitForGone(pids, 10_000), "worker processes still alive").toEqual([]);
    const teardowns = (await readLog(rootDir)).filter((entry) => entry.phase === "teardown");
    expect(teardowns.map((entry) => `${entry.fixture}:${entry.outcome}`).sort()).toEqual([
      "ledger:failed",
      "ledger:failed",
      "tenant:failed",
      "tenant:failed",
    ]);
  }, 40_000);

  it("gives a step under nuka run --concurrency 2 an empty stdin", async () => {
    const child = spawnNuka(rootDir, [
      "run",
      "--no-check",
      "features/read-stdin.feature",
      "features/read-stdin-stream.feature",
      "--quiet",
      "--concurrency",
      "2",
    ]);
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const closed = await waitForClose(child, 20_000);

    expect(closed, stderr()).toEqual({ code: 0, signal: null });
    const records = stdout()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status: string });
    expect(records.map((record) => record.status)).toEqual(["passed", "passed"]);
  }, 40_000);

  it("exits nuka run --concurrency 2 when project code listens on the worker's IPC channel", async () => {
    const child = spawnNuka(
      rootDir,
      ["run", "--no-check", "features/finish.feature", "features/finish-again.feature", "--quiet", "--concurrency", "2"],
      { ...process.env, IPC_MESSAGE_LISTENER: "1" },
    );
    const stderr = collect(child.stderr);
    const closed = await waitForClose(child, 20_000).finally(() => readFixturePids(rootDir));

    expect(closed, stderr()).toEqual({ code: 0, signal: null });
  }, 40_000);

  it("names project code closing a worker's IPC channel, and tears that worker down", async () => {
    const child = spawnNuka(
      rootDir,
      ["run", "--no-check", "features/hold.feature", "features/hold-again.feature", "--quiet", "--concurrency", "2"],
      { ...process.env, DISCONNECT_IPC: "1" },
    );
    const stderr = collect(child.stderr);
    const closed = await waitForClose(child, 20_000);

    expect(closed.code, stderr()).toBe(1);
    expect(
      stderr().split("\n").filter((line) => line === WORKER_DISCONNECTED_LINE),
    ).toHaveLength(2);
    const teardowns = (await readLog(rootDir)).filter((entry) => entry.phase === "teardown");
    expect(teardowns.map((entry) => `${entry.fixture}:${entry.outcome}`).sort()).toEqual([
      "ledger:failed",
      "ledger:failed",
      "tenant:failed",
      "tenant:failed",
    ]);
  }, 40_000);

  it("finishes a forwarded signal's teardown in every worker when the parent is then killed with SIGKILL", async () => {
    const child = spawnNuka(
      rootDir,
      ["run", "--no-check", "features/hold.feature", "features/hold-again.feature", "--quiet", "--concurrency", "2"],
      { ...process.env, SIGNAL_TEARDOWN_HOLD_MS: "3000" },
    );
    await waitForSetups(rootDir, 2);
    const pids = await readFixturePids(rootDir);
    child.kill("SIGTERM");
    const deadline = Date.now() + 20_000;
    while ((await readLog(rootDir)).filter((entry) => entry.phase === "teardown").length < 2) {
      if (Date.now() > deadline) throw new Error("tenant teardown did not start within 20s");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.kill("SIGKILL");
    await waitForClose(child, 5_000);

    expect(await waitForGone(pids, 15_000), "worker processes still alive").toEqual([]);
    const teardowns = (await readLog(rootDir)).filter((entry) => entry.phase === "teardown");
    expect(teardowns.map((entry) => `${entry.fixture}:${entry.outcome}`).sort()).toEqual([
      "ledger:failed",
      "ledger:failed",
      "tenant:failed",
      "tenant:failed",
    ]);
  }, 60_000);

  it("names a signal that arrives after every scenario had a record under nuka run --concurrency 2", async () => {
    const child = spawnNuka(
      rootDir,
      ["run", "--no-check", "features/finish.feature", "features/finish-again.feature", "--quiet", "--concurrency", "2"],
      { ...process.env, LEDGER_TEARDOWN_HOLD_MS: "3000" },
    );
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const deadline = Date.now() + 20_000;
    while ((await readLog(rootDir)).filter((entry) => entry.fixture === "ledger" && entry.phase === "teardown").length < 2) {
      if (Date.now() > deadline) throw new Error(`ledger teardown did not start within 20s:\n${stderr()}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const pids = await readFixturePids(rootDir);
    child.kill("SIGTERM");
    const closed = await waitForClose(child, 20_000);

    expect(stoppedBy("SIGTERM", closed.code, closed.signal), stderr()).toBe(true);
    expect(await waitForGone(pids, 5_000), "worker processes still alive").toEqual([]);
    expect(stdout().trim().split("\n")).toHaveLength(2);
    expect(stderr()).toContain("SIGTERM arrived after every scenario had a record, so AfterAll hooks may not have run.\n");
    expect(stderr()).toMatch(/^2 scenarios: 2 passed, 0 failed/m);
  }, 60_000);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    it(`tears both scopes down when nuka run receives ${signal}`, async () => {
      const child = spawnNuka(rootDir, ["run", "--no-check", "features/hold.feature", "--quiet"]);
      await waitForSetups(rootDir);
      child.kill(signal);
      const closed = await waitForClose(child, 10_000);

      expect(stoppedBy(signal, closed.code, closed.signal)).toBe(true);
      const log = await readLog(rootDir);
      const teardowns = log.filter((entry) => entry.phase === "teardown");
      expect(teardowns.map((entry) => entry.fixture)).toEqual(["tenant", "ledger"]);
      expect(teardowns.every((entry) => entry.outcome === "failed")).toBe(true);
    });

    it(`tears every worker's fixtures down when nuka run --concurrency 2 receives ${signal}`, async () => {
      const child = spawnNuka(rootDir, [
        "run",
        "--no-check",
        "features/hold.feature",
        "features/hold-again.feature",
        "features/serial-after.feature",
        "--quiet",
        "--concurrency",
        "2",
      ]);
      const stdout = collect(child.stdout);
      const stderr = collect(child.stderr);
      await waitForSetups(rootDir, 2);
      const pids = await readFixturePids(rootDir);
      child.kill(signal);
      const closed = await waitForClose(child, 20_000);

      expect(stoppedBy(signal, closed.code, closed.signal), stderr()).toBe(true);
      expect(await waitForGone(pids, 5_000), "worker processes still alive").toEqual([]);
      const log = await readLog(rootDir);
      expect(
        log.filter((entry) => entry.phase === "setup").length,
        "the queued @nukadoko:serial file started a worker",
      ).toBe(4);
      const teardowns = log.filter((entry) => entry.phase === "teardown");
      expect(teardowns.map((entry) => `${entry.fixture}:${entry.outcome}`).sort()).toEqual([
        "ledger:failed",
        "ledger:failed",
        "tenant:failed",
        "tenant:failed",
      ]);
      expect(stdout()).toBe("");
      expect(stderr()).toContain(`${signal} stopped this run before every scenario had a record, so it is incomplete.\n`);
      expect(stderr()).toMatch(/^0 scenarios: 0 passed, 0 failed/m);
    }, 40_000);

    it(`exits at once on a second ${signal} to nuka run --concurrency 2 and leaves no worker behind`, async () => {
      const child = spawnNuka(
        rootDir,
        ["run", "--no-check", "features/hold.feature", "features/hold-again.feature", "--quiet", "--concurrency", "2"],
        { ...process.env, SIGNAL_TEARDOWN_HOLD_MS: "120000" },
      );
      await waitForSetups(rootDir, 2);
      const pids = await readFixturePids(rootDir);
      child.kill(signal);
      const deadline = Date.now() + 20_000;
      while ((await readLog(rootDir)).filter((entry) => entry.phase === "teardown").length < 2) {
        if (Date.now() > deadline) throw new Error("tenant teardown did not start within 20s");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      child.kill(signal);
      const closed = await waitForClose(child, 5_000);

      expect(stoppedBy(signal, closed.code, closed.signal)).toBe(true);
      expect(await waitForGone(pids, 5_000), "worker processes still alive").toEqual([]);
      const log = await readLog(rootDir);
      expect(log.filter((entry) => entry.fixture === "ledger" && entry.phase === "teardown")).toEqual([]);
    }, 60_000);

    it(`tears both scopes down when nuka do receives ${signal}`, async () => {
      const child = spawnNuka(rootDir, ["do", "hold-fixture", "--args", "{}"]);
      await waitForSetups(rootDir);
      child.kill(signal);
      const closed = await waitForClose(child, 10_000);

      expect(stoppedBy(signal, closed.code, closed.signal)).toBe(true);
      const log = await readLog(rootDir);
      const teardowns = log.filter((entry) => entry.phase === "teardown");
      expect(teardowns.map((entry) => entry.fixture)).toEqual(["tenant", "ledger"]);
      expect(teardowns.every((entry) => entry.outcome === "failed")).toBe(true);
    });
  }
});
