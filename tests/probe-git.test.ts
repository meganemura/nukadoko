import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeGitState } from "../src/run/probe-git.js";
import { initGitRepo } from "./helpers/fixtures.js";

// Responsibility: unit tests for probeGitState (m4a-run-provenance task
// spec, test items 3-5; m4a-probe-cost task spec, test item 2's "no initial
// commit yet" addition) — each temp dir is created directly under the OS
// temp dir (never nested under this repo's own tree, unlike
// tests/helpers/fixtures.ts's `tempFixturesRoot`), so a "not a git
// repository" case genuinely has no ancestor `.git` for git to walk up
// into, and an "in a git repository" case gets its own freshly `git init`ed
// repo (tests/helpers/fixtures.ts's `initGitRepo`) rather than accidentally
// resolving to this very repository's own commit.

const execFileAsync = promisify(execFile);

describe("probeGitState", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-probe-git-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined outside a git repository, without throwing", async () => {
    await expect(probeGitState(dir)).resolves.toBeUndefined();
  });

  it("reports the HEAD commit and clean: true for a freshly committed, untouched repo", async () => {
    await writeFile(path.join(dir, "a.txt"), "a");
    const commit = await initGitRepo(dir);

    const state = await probeGitState(dir);
    expect(state).toEqual({ commit, clean: true });
    expect(state?.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports clean: false once an untracked file exists, even though HEAD is unchanged", async () => {
    await writeFile(path.join(dir, "a.txt"), "a");
    const commit = await initGitRepo(dir);

    await writeFile(path.join(dir, "untracked.txt"), "never added or committed");

    const state = await probeGitState(dir);
    expect(state).toEqual({ commit, clean: false });
  });

  it("returns undefined for a git-init'd repo with no commit yet, since no commit sha exists to report", async () => {
    // `git status --porcelain=v2 --branch` on a repo like this prints
    // `# branch.oid (initial)` — no sha, so probeGitState must not surface
    // any `git` field at all (m4a-probe-cost task spec: "commit が無ければ
    // 「commit X で green だった」という主張自体が立たない").
    await execFileAsync("git", ["-C", dir, "init", "-q"]);
    await writeFile(path.join(dir, "a.txt"), "a");

    await expect(probeGitState(dir)).resolves.toBeUndefined();
  });
});
