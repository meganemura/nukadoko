import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { copyFixtureToTempDir, removeTempDir, repoRoot, sourceNodeArgs } from "./helpers/fixtures.js";

// Responsibility: a signal during `nuka run --base`'s base world stops
// the base's program and removes the trees, as a signal during head's
// world stops head's program (tests/program-start-signal.test.ts): while
// the base world starts, the start is aborted; once it runs, the world is
// stopped the way a pass stops it, with SIGTERM and its grace period. A
// program left running in a removed tree would outlive nukadoko.
//
// Head's program answers, so head's pass runs. Each base below is a
// commit whose copy of the program writes its pid beside the world's
// database and then waits: one never answers, so its world never starts,
// and one answers the ready check and never a step's request (the one that
// carries a `traceparent`), so its pass never ends. The child is
// `src/cli.ts` under nukadoko's own loader: a signal delivered to this
// vitest process would end the runner. POSIX only: Windows has no SIGTERM
// to send to a process.

const SPAWNED_TEST_TIMEOUT_MS = 120_000;
// What a stop may take from the signal to the exit. A start that waited
// for the program would take its serve limit, 60 s.
const STOP_WITHIN_MS = 15_000;

const NEVER_READY = `import { writeFileSync } from "node:fs";
import path from "node:path";

writeFileSync(path.join(path.dirname(process.env.DB), "server-pid.txt"), \`\${process.pid}\\n\`);
setInterval(() => {}, 1000);
`;

const NEVER_ANSWERS_A_STEP = `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const beside = (name) => path.join(path.dirname(process.env.DB), name);
process.on("SIGTERM", () => {
  writeFileSync(beside("got-sigterm.txt"), "\\n");
  process.exit(0);
});
createServer((req, res) => {
  if (req.headers.traceparent === undefined) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  writeFileSync(beside("server-pid.txt"), \`\${process.pid}\\n\`);
}).listen(Number(process.env.PORT));
`;

const PROGRAM = `import { defineProgram } from "./nukadoko-shim.js";

export default defineProgram({
  serve: { command: "node app/server.mjs", ready: "/whoami", timeout_ms: 60000 },
  env: { PORT: "{port}", DB: "{dir}/db.sqlite3", TOKEN: "{token}" },
});
`;

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

describe.runIf(process.platform !== "win32")("a signal during nuka run --base's base world", () => {
  let rootDir: string;
  const children: ChildProcess[] = [];
  const basePids: number[] = [];

  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", rootDir, "-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { encoding: "utf8" }).trim();

  beforeAll(async () => {
    rootDir = await copyFixtureToTempDir("program-project");
    // A tree sits deeper than the project, so the shim names nukadoko by
    // an absolute URL, which loads from inside a tree as from the project.
    writeFileSync(path.join(rootDir, "nukadoko-shim.ts"), `export * from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "src", "index.ts")).href)};\n`);
    writeFileSync(path.join(rootDir, "nukadoko.program.ts"), PROGRAM);
    writeFileSync(path.join(rootDir, ".gitignore"), ".nukadoko/\n");
    const server = readFileSync(path.join(rootDir, "app", "server.mjs"), "utf8");
    writeFileSync(path.join(rootDir, "app", "server.mjs"), NEVER_READY);
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "a program that never answers");
    git("branch", "never-ready");
    writeFileSync(path.join(rootDir, "app", "server.mjs"), NEVER_ANSWERS_A_STEP);
    git("commit", "-qam", "a program that never answers a step");
    git("branch", "never-answers-a-step");
    // Head: a program that answers, and a new criterion, which runs in the
    // base world once head passes it.
    writeFileSync(path.join(rootDir, "app", "server.mjs"), server);
    const feature = path.join(rootDir, "features", "world.feature");
    writeFileSync(
      feature,
      `${readFileSync(feature, "utf8").trimEnd()}\n\n  Scenario: the program answers again\n    When I ask the program who it is\n    Then the program and the step saw the same database\n`,
    );
    git("add", "-A");
    git("commit", "-qm", "head");
  });

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    for (const pid of basePids.splice(0)) {
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  /** Runs `nuka run --base <ref>`, sends SIGTERM once the base's program
   * has written its pid, and waits for the run to end. */
  async function signalledRun(ref: string): Promise<{ code: number | null; elapsedMs: number; pid: number; worldDir: string; runDir: string }> {
    const runs = path.join(rootDir, ".nukadoko", "runs");
    const before = new Set(existsSync(runs) ? readdirSync(runs) : []);
    const child = spawn(process.execPath, [...sourceNodeArgs, path.join(repoRoot, "src", "cli.ts"), "run", "--base", ref], {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout!.resume();
    const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    for (;;) {
      const runDir = (existsSync(runs) ? readdirSync(runs) : []).filter((name) => !before.has(name)).map((name) => path.join(runs, name))[0];
      const worldDir = runDir === undefined ? undefined : path.join(runDir, "worlds", "default@base");
      const pidFile = worldDir === undefined ? undefined : path.join(worldDir, "server-pid.txt");
      if (runDir !== undefined && worldDir !== undefined && pidFile !== undefined && existsSync(pidFile)) {
        const text = readFileSync(pidFile, "utf8");
        if (text.endsWith("\n")) {
          const pid = Number(text.trim());
          basePids.push(pid);
          const signalledAt = Date.now();
          child.kill("SIGTERM");
          const code = await closed;
          return { code, elapsedMs: Date.now() - signalledAt, pid, worldDir, runDir };
        }
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`the run exited before the base's program wrote its pid (code ${child.exitCode}).\nstderr:\n${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const treesGone = (runDir: string): void => {
    expect(existsSync(path.join(runDir, "trees"))).toBe(false);
    expect(git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
  };

  it(
    "aborts the base world's start, removes the trees, and exits",
    async () => {
      const { code, elapsedMs, pid, runDir } = await signalledRun("never-ready");
      expect(elapsedMs).toBeLessThan(STOP_WITHIN_MS);
      expect(code).toBe(143);
      expect(await stillAlive(pid)).toBe(false);
      treesGone(runDir);
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it(
    "stops the running base world with SIGTERM, removes the trees, and exits",
    async () => {
      const { code, elapsedMs, pid, worldDir, runDir } = await signalledRun("never-answers-a-step");
      expect(elapsedMs).toBeLessThan(STOP_WITHIN_MS);
      expect(code).toBe(143);
      expect(await stillAlive(pid)).toBe(false);
      // The world's stop, and not the kill at exit that only SIGKILL can
      // be, ended it.
      expect(existsSync(path.join(worldDir, "got-sigterm.txt"))).toBe(true);
      treesGone(runDir);
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );
});
