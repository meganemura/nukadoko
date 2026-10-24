import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { feature, makeBaseProject, scenario, type BaseProject } from "./helpers/base-project.js";
import { removeTempDir } from "./helpers/fixtures.js";

// Responsibility: what `nuka run --base` does to the repository itself
// (src/run/git-ref.ts): it makes the base tree with the repository's hooks
// off, and the registration a killed run leaves behind is removed by the
// next `nuka run --base` and by `nuka clean` once its directory is gone,
// while every other registration stays.

describe("nuka run --base and the repository", () => {
  let project: BaseProject & { readonly top: string };
  const marker = (): string => `${project.top}-hook-ran.txt`;
  const elsewhere = (): string => `${project.top}-elsewhere`;
  const registered = (): string[] =>
    project
      .git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));

  beforeAll(async () => {
    project = await makeBaseProject();
    project.write({ "features/cart.feature": feature(scenario("three items", 3, 6)) });
    project.commit("base");
    project.git("branch", "base-branch");
    project.write({ "features/cart.feature": feature(scenario("three items", 3, 6), scenario("four items", 4, 8)) });
    project.commit("head");
    const hook = path.join(project.top, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\necho "$PWD" >> ${JSON.stringify(marker())}\n`);
    chmodSync(hook, 0o755);
  }, 60_000);

  afterAll(async () => {
    rmSync(marker(), { force: true });
    await removeTempDir(project.top);
  });

  it("makes the base tree without running the repository's hooks", async () => {
    const result = await project.cli(["run", "--base", "base-branch"]);
    expect(result.stderr).toContain("base default  features/cart.feature:7  four items");
    expect(existsSync(marker())).toBe(false);
    expect(registered()).toEqual([project.top]);
  }, 60_000);

  it("removes the registration a killed run left once its directory is gone, and no other", async () => {
    // What a SIGKILL leaves: a registered base tree under the runs
    // directory. Beside it, a registration elsewhere whose directory is gone.
    const leftover = path.join(project.root, ".nukadoko", "runs", "run-killed", "trees", "base");
    project.git("worktree", "add", "--detach", "--quiet", leftover, "HEAD");
    project.git("worktree", "add", "--detach", "--quiet", elsewhere(), "HEAD");
    rmSync(elsewhere(), { recursive: true, force: true });
    // A tree still on disk is not removed by a run: its run may be alive.
    await project.cli(["run", "--base", "base-branch"]);
    expect(registered().sort()).toEqual([project.top, elsewhere(), leftover].sort());
    // nuka clean removes the run's directory, and then its registration.
    expect((await project.cli(["clean"])).exitCode).toBe(0);
    expect(registered().sort()).toEqual([project.top, elsewhere()].sort());
    // So does the next run, for a directory something else removed.
    project.git("worktree", "add", "--detach", "--quiet", leftover, "HEAD");
    rmSync(path.join(project.root, ".nukadoko", "runs", "run-killed"), { recursive: true, force: true });
    await project.cli(["run", "--base", "base-branch"]);
    expect(registered().sort()).toEqual([project.top, elsewhere()].sort());
  }, 120_000);
});
