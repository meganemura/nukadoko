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
} from "./helpers/fixtures.js";

// Responsibility: SIGINT and SIGTERM during `nuka run` or `nuka do` still
// run fixture teardown, and a normal finish still does too.
//
// The signal cases spawn a real process. Delivering the signal to this
// vitest process would tear the runner down, so the child is `src/cli.ts`
// under tsx with the fixture project as its cwd. The child is killed if a
// case ends while it is still alive.

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

function spawnNuka(rootDir: string, args: readonly string[]): ChildProcess {
  const child = spawn(
    process.execPath,
    [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), path.join(repoRoot, "src", "cli.ts"), ...args],
    { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  return child;
}

async function waitForSetups(rootDir: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const log = await readLog(rootDir);
    const setups = new Set(log.filter((entry) => entry.phase === "setup").map((entry) => entry.fixture));
    if (setups.has("tenant") && setups.has("ledger")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fixture setup was not logged within 20s:\n${JSON.stringify(await readLog(rootDir))}`);
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
    await removeTempDir(rootDir);
  });

  it("tears both scopes down when nuka run finishes", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/finish.feature"], { rootDir, stdout, stderr });

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

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`tears both scopes down when nuka run receives ${signal}`, async () => {
      const child = spawnNuka(rootDir, ["run", "features/hold.feature", "--quiet"]);
      await waitForSetups(rootDir);
      child.kill(signal);
      const closed = await waitForClose(child, 10_000);

      expect(stoppedBy(signal, closed.code, closed.signal)).toBe(true);
      const log = await readLog(rootDir);
      const teardowns = log.filter((entry) => entry.phase === "teardown");
      expect(teardowns.map((entry) => entry.fixture)).toEqual(["tenant", "ledger"]);
      expect(teardowns.every((entry) => entry.outcome === "failed")).toBe(true);
    });

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
