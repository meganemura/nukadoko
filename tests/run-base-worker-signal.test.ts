import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cartModule, feature, makeBaseProject, scenario, type BaseProject } from "./helpers/base-project.js";
import { removeTempDir, repoRoot, sourceNodeArgs } from "./helpers/fixtures.js";

// Responsibility: a signal during a tree pass of `nuka run --base` stops
// the pass's workers before nukadoko exits: SIGTERM, the grace period a
// world gets, then SIGKILL, so a worker busy in a step cannot outlive the
// run and its removed tree. A worker's files are in the run directory.
//
// The base's program code spins for a minute on four items, after writing
// the worker's pid, so the base world's worker is busy in a step when the
// signal arrives and cannot run its own handler. The child is `src/cli.ts`
// under nukadoko's own loader: a signal to this vitest process would end
// the runner. POSIX only.

const SPAWNED_TEST_TIMEOUT_MS = 120_000;
// The grace period is 5 seconds; the rest is the exit.
const STOP_WITHIN_MS = 15_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(process.platform !== "win32")("a signal during a tree pass of nuka run --base", () => {
  let project: BaseProject & { readonly top: string };
  let child: ChildProcess | undefined;
  let workerPid: number | undefined;
  const pidFile = (): string => `${project.top}-worker-pid.txt`;

  beforeAll(async () => {
    project = await makeBaseProject();
    project.write({
      "features/cart.feature": feature(scenario("three items", 3, 6)),
      "lib/cart.mjs": `import { writeFileSync } from "node:fs";\nexport function total(count) {\n  if (count === 4) {\n    writeFileSync(${JSON.stringify(pidFile())}, \`\${process.pid}\\n\`);\n    const end = Date.now() + 60000;\n    while (Date.now() < end) {}\n  }\n  return count * 2;\n}\n`,
    });
    project.commit("a base whose four items never return");
    project.git("branch", "base-branch");
    project.write({ "features/cart.feature": feature(scenario("three items", 3, 6), scenario("four items", 4, 9)), "lib/cart.mjs": cartModule("return count === 4 ? 9 : count * 2;") });
    project.commit("head");
  }, 60_000);

  afterEach(() => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (workerPid !== undefined && isAlive(workerPid)) process.kill(workerPid, "SIGKILL");
  });

  afterAll(async () => {
    rmSync(pidFile(), { force: true });
    await removeTempDir(project.top);
  });

  it(
    "stops a busy worker within the grace period, keeps its files in the run directory, and removes the trees",
    async () => {
      const runs = path.join(project.root, ".nukadoko", "runs");
      child = spawn(process.execPath, [...sourceNodeArgs, path.join(repoRoot, "src", "cli.ts"), "run", "--base", "base-branch"], {
        cwd: project.root,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const closed = new Promise<number | null>((resolve) => child!.once("close", (code) => resolve(code)));
      while (!(existsSync(pidFile()) && readFileSync(pidFile(), "utf8").endsWith("\n"))) {
        if (child.exitCode !== null) throw new Error(`the run ended before the base's worker was busy.\nstderr:\n${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      workerPid = Number(readFileSync(pidFile(), "utf8").trim());
      const runDir = path.join(runs, readdirSync(runs)[0]!);
      expect(readdirSync(runDir).filter((name) => name.startsWith(".tree-pass-"))).toHaveLength(1);
      const signalledAt = Date.now();
      child.kill("SIGINT");
      expect(await closed).toBe(130);
      expect(Date.now() - signalledAt).toBeLessThan(STOP_WITHIN_MS);
      // The worker is gone once nukadoko is; a killed child is reaped by
      // init, which may take a moment.
      for (let waited = 0; waited < 2_000 && isAlive(workerPid); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(isAlive(workerPid)).toBe(false);
      expect(existsSync(path.join(runDir, "trees"))).toBe(false);
      expect(project.git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );
});
