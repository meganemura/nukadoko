import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFixtureToTempDir, removeTempDir, repoRoot, sourceNodeArgs } from "./helpers/fixtures.js";

// Responsibility: a signal while a world is starting stops the program at
// once and leaves nothing running, in `nuka do` and in `nuka run
// --concurrency`, whose parent starts the world. The program here never
// answers ready, so without the signal the start would wait for its whole
// limit.
//
// The child is `src/cli.ts` under nukadoko's own loader, as in
// tests/run-fixture-signal-teardown.test.ts: a signal delivered to this
// vitest process would end the runner. POSIX only: Windows has no SIGTERM
// to send to a process.

const SPAWNED_TEST_TIMEOUT_MS = 120_000;
// What a stopped start may take from the signal to the exit. A start that
// waited for the program would take the serve limit below, 60 s.
const STOP_WITHIN_MS = 15_000;

const children: ChildProcess[] = [];
const serverPids: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether `pid` is still alive after up to 2 s: a killed process is gone
 * only once its parent, or init, has reaped it. */
async function stillAlive(pid: number): Promise<boolean> {
  for (let waited = 0; waited < 2_000; waited += 50) {
    if (!isAlive(pid)) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return isAlive(pid);
}

function spawnNuka(rootDir: string, args: readonly string[]): { child: ChildProcess; stderr: () => string; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const child = spawn(process.execPath, [...sourceNodeArgs, path.join(repoRoot, "src", "cli.ts"), ...args], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let text = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    text += chunk;
  });
  child.stdout!.resume();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, stderr: () => text, closed };
}

/** The program's pid, once it has written it: the world is then starting
 * and waiting for the program to answer. */
async function serverPid(rootDir: string, child: ChildProcess, stderr: () => string): Promise<number> {
  const file = path.join(rootDir, "server-pid.txt");
  for (;;) {
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8");
      if (text.endsWith("\n")) {
        const pid = Number(text.trim());
        serverPids.push(pid);
        return pid;
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the child exited before the program started (code ${child.exitCode}, signal ${child.signalCode}).\nstderr:\n${stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.runIf(process.platform !== "win32")("a signal while a world starts", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("program-project");
    // Writes its pid and never listens, so the world waits for it.
    await writeFile(
      path.join(rootDir, "app", "never-ready.mjs"),
      'import { writeFileSync } from "node:fs";\nwriteFileSync("server-pid.txt", `${process.pid}\\n`);\nsetInterval(() => {}, 1000);\n',
    );
    await writeFile(
      path.join(rootDir, "nukadoko.program.ts"),
      'import { defineProgram } from "./nukadoko-shim.js";\nexport default defineProgram({ serve: { command: "node app/never-ready.mjs", ready: "/whoami", timeout_ms: 60000 }, env: { PORT: "{port}" } });\n',
    );
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    for (const pid of serverPids.splice(0)) {
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
    }
    await removeTempDir(rootDir);
  });

  it(
    "nuka do stops the program and exits",
    async () => {
      const { child, stderr, closed } = spawnNuka(rootDir, ["do", "ask-program", "--args", "{}"]);
      const pid = await serverPid(rootDir, child, stderr);

      const signalledAt = Date.now();
      child.kill("SIGTERM");
      const { code } = await closed;

      expect(Date.now() - signalledAt).toBeLessThan(STOP_WITHIN_MS);
      expect(code).toBe(143);
      expect(await stillAlive(pid)).toBe(false);
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it(
    "nuka run --concurrency 2 stops the program at once, reports no start failure, and exits",
    async () => {
      await copyFile(path.join(rootDir, "features", "world.feature"), path.join(rootDir, "features", "world-again.feature"));
      const { child, stderr, closed } = spawnNuka(rootDir, ["run", "--no-check", "--concurrency", "2"]);
      const pid = await serverPid(rootDir, child, stderr);

      const signalledAt = Date.now();
      child.kill("SIGTERM");
      const { code } = await closed;

      expect(Date.now() - signalledAt).toBeLessThan(STOP_WITHIN_MS);
      expect(code).toBe(143);
      expect(await stillAlive(pid)).toBe(false);
      expect(stderr()).toContain("failed\trun-incomplete\t-\tSIGTERM stopped this run");
      expect(stderr()).not.toContain("program-start-failed");
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );
});
