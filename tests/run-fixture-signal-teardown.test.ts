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
// Every `nuka run` here passes `--no-check`: the static check's extra step
// discovery before the workers start is not what these cases cover.
//
// A loaded runner can take tens of seconds to start the CLI and its
// workers, so no wait here has a deadline of its own. Each one waits for
// its event and fails at once, with the child's stderr, if the child exits
// first. A wait that never ends is a hang, and the test's own timeout,
// SPAWNED_TEST_TIMEOUT_MS, is the one bound that catches it; afterEach then
// names the event the test was still waiting for.

interface LogEntry {
  readonly fixture: string;
  readonly phase: string;
  readonly outcome?: string;
}

const SPAWNED_TEST_TIMEOUT_MS = 120_000;

const children: ChildProcess[] = [];
const spawnedStderr = new Map<ChildProcess, () => string>();
const spawnedClose = new Map<ChildProcess, Promise<{ code: number | null; signal: NodeJS.Signals | null }>>();
let waitingFor: string | null = null;

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
  "failed\trun-incomplete\t-\tCode in this worker closed its IPC channel to the parent while the parent was still running " +
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
  spawnedStderr.set(child, collect(child.stderr));
  spawnedClose.set(
    child,
    new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
  );
  return child;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForLog(
  rootDir: string,
  child: ChildProcess,
  event: string,
  happened: (log: LogEntry[]) => boolean,
): Promise<void> {
  waitingFor = event;
  for (;;) {
    const exited = hasExited(child);
    const log = await readLog(rootDir);
    if (happened(log)) break;
    if (exited) {
      waitingFor = null;
      throw new Error(
        `${event}: the child exited first (code ${child.exitCode}, signal ${child.signalCode}).\n` +
          `log: ${JSON.stringify(log)}\nstderr:\n${spawnedStderr.get(child)?.() ?? ""}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  waitingFor = null;
}

function waitForSetups(rootDir: string, child: ChildProcess, perFixture = 1): Promise<void> {
  return waitForLog(rootDir, child, `${perFixture} setup(s) of tenant and of ledger`, (log) => {
    const setups = log.filter((entry) => entry.phase === "setup");
    const count = (fixture: string): number => setups.filter((entry) => entry.fixture === fixture).length;
    return count("tenant") >= perFixture && count("ledger") >= perFixture;
  });
}

function waitForTeardowns(rootDir: string, child: ChildProcess, count: number, fixture?: string): Promise<void> {
  return waitForLog(rootDir, child, `${count} ${fixture ?? "fixture"} teardown(s) to start`, (log) =>
    log.filter((entry) => entry.phase === "teardown" && (fixture === undefined || entry.fixture === fixture))
      .length >= count,
  );
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

async function waitForGone(pids: readonly number[]): Promise<void> {
  waitingFor = `worker processes ${pids.join(", ")} to exit`;
  while (pids.some(isAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  waitingFor = null;
}

function collect(stream: NodeJS.ReadableStream | null): () => string {
  let text = "";
  stream?.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return () => text;
}

async function waitForClose(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  waitingFor = `child ${child.pid} to exit and close its output`;
  const closed = await spawnedClose.get(child)!;
  waitingFor = null;
  return closed;
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
    spawnedStderr.clear();
    spawnedClose.clear();
    for (const pid of workerPids) {
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
    }
    workerPids.length = 0;
    await removeTempDir(rootDir);
    const unfinished = waitingFor;
    waitingFor = null;
    if (unfinished !== null) throw new Error(`the test ended while still waiting for ${unfinished}`);
  });

  it("tears both scopes down when nuka run finishes", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/finish.feature"], { rootDir, stdout, stderr });

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
      "--records",
      "--no-check",
      "features/hold.feature",
      "features/hold-again.feature",
      "--concurrency",
      "2",
    ]);
    await waitForSetups(rootDir, child, 2);
    const pids = await readFixturePids(rootDir);
    child.kill("SIGKILL");
    await waitForClose(child);

    await waitForGone(pids);
    const teardowns = (await readLog(rootDir)).filter((entry) => entry.phase === "teardown");
    expect(teardowns.map((entry) => `${entry.fixture}:${entry.outcome}`).sort()).toEqual([
      "ledger:failed",
      "ledger:failed",
      "tenant:failed",
      "tenant:failed",
    ]);
  }, SPAWNED_TEST_TIMEOUT_MS);

  it("tears every worker's fixtures down when they write to stdout and stderr after the parent is killed with SIGKILL", async () => {
    const child = spawnNuka(
      rootDir,
      ["run", "--records", "--no-check", "features/hold.feature", "features/hold-again.feature", "--concurrency", "2"],
      { ...process.env, TEARDOWN_WRITES: "1" },
    );
    await waitForSetups(rootDir, child, 2);
    const pids = await readFixturePids(rootDir);
    child.kill("SIGKILL");
    await waitForClose(child);

    await waitForGone(pids);
    const teardowns = (await readLog(rootDir)).filter((entry) => entry.phase === "teardown");
    expect(teardowns.map((entry) => `${entry.fixture}:${entry.outcome}`).sort()).toEqual([
      "ledger:failed",
      "ledger:failed",
      "tenant:failed",
      "tenant:failed",
    ]);
  }, SPAWNED_TEST_TIMEOUT_MS);

  it("gives a step under nuka run --concurrency 2 an empty stdin", async () => {
    const child = spawnNuka(rootDir, [
      "run",
      "--records",
      "--no-check",
      "features/read-stdin.feature",
      "features/read-stdin-stream.feature",
      "--concurrency",
      "2",
    ]);
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const closed = await waitForClose(child);

    expect(closed, stderr()).toEqual({ code: 0, signal: null });
    const records = stdout()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status: string });
    expect(records.map((record) => record.status)).toEqual(["passed", "passed"]);
  }, SPAWNED_TEST_TIMEOUT_MS);

  it("exits nuka run --concurrency 2 when project code listens on the worker's IPC channel", async () => {
    const child = spawnNuka(
      rootDir,
      ["run", "--records", "--no-check", "features/finish.feature", "features/finish-again.feature", "--concurrency", "2"],
      { ...process.env, IPC_MESSAGE_LISTENER: "1" },
    );
    const stderr = collect(child.stderr);
    const closed = await waitForClose(child).finally(() => readFixturePids(rootDir));

    expect(closed, stderr()).toEqual({ code: 0, signal: null });
  }, SPAWNED_TEST_TIMEOUT_MS);

  it("names project code closing a worker's IPC channel, and tears that worker down", async () => {
    const child = spawnNuka(
      rootDir,
      ["run", "--records", "--no-check", "features/hold.feature", "features/hold-again.feature", "--concurrency", "2"],
      { ...process.env, DISCONNECT_IPC: "1" },
    );
    const stderr = collect(child.stderr);
    const closed = await waitForClose(child);

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
  }, SPAWNED_TEST_TIMEOUT_MS);

  it("finishes a forwarded signal's teardown in every worker when the parent is then killed with SIGKILL", async () => {
    const child = spawnNuka(
      rootDir,
      ["run", "--records", "--no-check", "features/hold.feature", "features/hold-again.feature", "--concurrency", "2"],
      { ...process.env, SIGNAL_TEARDOWN_HOLD_MS: "3000" },
    );
    await waitForSetups(rootDir, child, 2);
    const pids = await readFixturePids(rootDir);
    child.kill("SIGTERM");
    await waitForTeardowns(rootDir, child, 2);
    child.kill("SIGKILL");
    await waitForClose(child);

    await waitForGone(pids);
    const teardowns = (await readLog(rootDir)).filter((entry) => entry.phase === "teardown");
    expect(teardowns.map((entry) => `${entry.fixture}:${entry.outcome}`).sort()).toEqual([
      "ledger:failed",
      "ledger:failed",
      "tenant:failed",
      "tenant:failed",
    ]);
  }, SPAWNED_TEST_TIMEOUT_MS);

  it("names a signal that arrives after every scenario had a record under nuka run --concurrency 2", async () => {
    const child = spawnNuka(
      rootDir,
      ["run", "--records", "--no-check", "features/finish.feature", "features/finish-again.feature", "--concurrency", "2"],
      { ...process.env, LEDGER_TEARDOWN_HOLD_MS: "3000" },
    );
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    await waitForTeardowns(rootDir, child, 2, "ledger");
    const pids = await readFixturePids(rootDir);
    child.kill("SIGTERM");
    const closed = await waitForClose(child);

    expect(stoppedBy("SIGTERM", closed.code, closed.signal), stderr()).toBe(true);
    await waitForGone(pids);
    expect(stdout().trim().split("\n")).toHaveLength(2);
    expect(stderr()).toContain(
      "failed\trun-incomplete\t-\tSIGTERM arrived after every scenario had a record, so AfterAll hooks may not have run\n" +
        "  fix: Run the scenarios again; the message names what stopped the run.\n",
    );
    expect(stderr()).toMatch(/^2 scenarios: 2 passed, 0 failed/m);
  }, SPAWNED_TEST_TIMEOUT_MS);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    it(`tears both scopes down when nuka run receives ${signal}`, async () => {
      const child = spawnNuka(rootDir, ["run", "--records", "--no-check", "features/hold.feature"]);
      await waitForSetups(rootDir, child);
      child.kill(signal);
      const closed = await waitForClose(child);

      expect(stoppedBy(signal, closed.code, closed.signal)).toBe(true);
      const log = await readLog(rootDir);
      const teardowns = log.filter((entry) => entry.phase === "teardown");
      expect(teardowns.map((entry) => entry.fixture)).toEqual(["tenant", "ledger"]);
      expect(teardowns.every((entry) => entry.outcome === "failed")).toBe(true);
    }, SPAWNED_TEST_TIMEOUT_MS);

    it(`tears every worker's fixtures down when nuka run --concurrency 2 receives ${signal}`, async () => {
      const child = spawnNuka(rootDir, [
        "run",
        "--records",
        "--no-check",
        "features/hold.feature",
        "features/hold-again.feature",
        "features/serial-after.feature",
        "--concurrency",
        "2",
      ]);
      const stdout = collect(child.stdout);
      const stderr = collect(child.stderr);
      await waitForSetups(rootDir, child, 2);
      const pids = await readFixturePids(rootDir);
      child.kill(signal);
      const closed = await waitForClose(child);

      expect(stoppedBy(signal, closed.code, closed.signal), stderr()).toBe(true);
      await waitForGone(pids);
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
      expect(stderr()).toContain(
        `failed\trun-incomplete\t-\t${signal} stopped this run before every scenario had a record, so it is incomplete\n` +
          "  fix: Run the scenarios again; the message names what stopped the run.\n",
      );
      expect(stderr()).toMatch(/^0 scenarios: 0 passed, 0 failed/m);
    }, SPAWNED_TEST_TIMEOUT_MS);

    it(`exits at once on a second ${signal} to nuka run --concurrency 2 and leaves no worker behind`, async () => {
      const child = spawnNuka(
        rootDir,
        ["run", "--records", "--no-check", "features/hold.feature", "features/hold-again.feature", "--concurrency", "2"],
        { ...process.env, SIGNAL_TEARDOWN_HOLD_MS: String(5 * SPAWNED_TEST_TIMEOUT_MS) },
      );
      await waitForSetups(rootDir, child, 2);
      const pids = await readFixturePids(rootDir);
      child.kill(signal);
      await waitForTeardowns(rootDir, child, 2);
      child.kill(signal);
      const closed = await waitForClose(child);

      expect(stoppedBy(signal, closed.code, closed.signal)).toBe(true);
      await waitForGone(pids);
      const log = await readLog(rootDir);
      expect(log.filter((entry) => entry.fixture === "ledger" && entry.phase === "teardown")).toEqual([]);
    }, SPAWNED_TEST_TIMEOUT_MS);

    it(`tears both scopes down when nuka do receives ${signal}`, async () => {
      const child = spawnNuka(rootDir, ["do", "hold-fixture", "--args", "{}"]);
      await waitForSetups(rootDir, child);
      child.kill(signal);
      const closed = await waitForClose(child);

      expect(stoppedBy(signal, closed.code, closed.signal)).toBe(true);
      const log = await readLog(rootDir);
      const teardowns = log.filter((entry) => entry.phase === "teardown");
      expect(teardowns.map((entry) => entry.fixture)).toEqual(["tenant", "ledger"]);
      expect(teardowns.every((entry) => entry.outcome === "failed")).toBe(true);
    }, SPAWNED_TEST_TIMEOUT_MS);
  }
});
