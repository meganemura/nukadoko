import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cartModule, feature, makeBaseProject, scenario, type BaseProject } from "./helpers/base-project.js";
import { removeTempDir, repoRoot, sourceNodeArgs } from "./helpers/fixtures.js";

// Responsibility: a signal while `nuka run --base` makes its trees
// (docs/spec.md "Verdicts") ends the run with 128 plus the signal's
// number, and leaves no tree and no worktree registration behind, as a
// signal later in the run does. A checkout filter that sleeps makes the
// base tree's checkout slow enough to signal during it. The child is
// `src/cli.ts` under nukadoko's own loader: a signal to this vitest
// process would end the runner. POSIX only.

let project: (BaseProject & { readonly top: string }) | undefined;

afterEach(async () => {
  if (project !== undefined) await removeTempDir(project.top);
  project = undefined;
});

describe.runIf(process.platform !== "win32")("a signal while nuka run --base makes its trees", () => {
  it("exits with 130 and removes the base tree and its worktree registration", async () => {
    project = await makeBaseProject();
    project.git("config", "filter.slow.smudge", "sh -c 'sleep 3; cat'");
    project.git("config", "filter.slow.clean", "cat");
    project.write({ ".gitattributes": "lib/cart.mjs filter=slow\n", "lib/cart.mjs": cartModule("return count;"), "features/cart.feature": "Feature: Cart\n" });
    project.commit("base");
    project.write({ "lib/cart.mjs": cartModule(), "features/cart.feature": feature(scenario("three items", 3, 6)) });
    project.commit("head");
    const child = spawn(process.execPath, [...sourceNodeArgs, path.join(repoRoot, "src", "cli.ts"), "run", "--base", "HEAD~1"], {
      cwd: project.root,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    const runs = path.join(project.root, ".nukadoko", "runs");
    // The checkout has begun once git made the tree's directory.
    const treeOf = (): string | undefined => (existsSync(runs) ? readdirSync(runs).map((id) => path.join(runs, id, "trees", "base")).find((dir) => existsSync(dir)) : undefined);
    while (treeOf() === undefined) {
      if (child.exitCode !== null) throw new Error(`the run ended before it made the base tree.\nstderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const runDir = path.dirname(path.dirname(treeOf()!));
    child.kill("SIGINT");
    expect(await ended).toEqual({ code: 130, signal: null });
    expect(existsSync(path.join(runDir, "trees"))).toBe(false);
    expect(project.git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
  }, 60_000);
});
