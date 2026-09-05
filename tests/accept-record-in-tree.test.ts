import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);

// Responsibility: what refusal condition 3 (dirty tree) makes of an
// acceptance record. Two halves, and skills/acceptance/references/
// maintenance.md promises both to a reader about to delete a record by
// hand:
//
//   a record sitting in the tree is set aside (`isAcceptanceRecordPath`
//   recognises it by frontmatter), so a second feature from the same run
//   needs no commit in between;
//   a record that was deleted cannot be read, so it cannot be recognised
//   as a record, and it counts as an ordinary dirty path.
//
// The second half is what a project actually hit: `rm -f features/*.md`
// before re-taking records, refused (correctly), and then committed by the
// next command in the same `&&` chain.
//
// This file rewrites the fixture's own `.gitignore` first, and that is the
// whole reason it can test anything. `tests/fixtures/accept-project`
// ignores `features/*.md`, so every acceptance record it writes is
// invisible to `git status` and never reaches the dirty-path list at all.
// Under that ignore the first test below passes without the exemption ever
// running, and the second cannot be written: deleting an ignored file
// leaves the tree clean. Every assertion here is guarded by a `git status`
// check for that reason, so the ignore coming back cannot quietly make
// these tests vacuous again.

function recordsIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();
}

describe("nuka accept and an acceptance record in the working tree", () => {
  let rootDir: string;
  let featuresDir: string;

  const gitStatus = async (): Promise<string> =>
    (await execFileAsync("git", ["status", "--porcelain"], { cwd: rootDir, encoding: "utf8" })).stdout;

  const commitAll = async (message: string): Promise<void> => {
    await execFileAsync("git", ["add", "-A"], { cwd: rootDir });
    // Identity named per invocation: initGitRepo set it in this repo's own
    // config, but naming it here keeps this commit independent of that.
    await execFileAsync(
      "git",
      [
        "-c",
        "user.email=nukadoko-tests@example.invalid",
        "-c",
        "user.name=nukadoko tests",
        "commit",
        "-q",
        "-m",
        message,
      ],
      { cwd: rootDir },
    );
  };

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
    featuresDir = path.join(rootDir, "features");
    // Only the state directory stays ignored: an acceptance record has to
    // be visible to git for either half of this file to mean anything.
    await writeFile(path.join(rootDir, ".gitignore"), ".nukadoko/\n");
    await initGitRepo(rootDir);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("accepts a second feature from the same run while the first record sits untracked", async () => {
    // One directory run covers greeting and multi (and failing, which is
    // red and is nobody's concern here).
    expect(
      await runCli(["run", "features"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() }),
    ).toBe(1);

    const firstErr = createCaptureSink();
    expect(
      await runCli(["accept", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr: firstErr }),
      firstErr.text(),
    ).toBe(0);
    const [record] = recordsIn(featuresDir);
    expect(record).toBeDefined();

    // The guard: git really does see that record as an untracked change.
    // Without this, the accept below could pass because nothing was dirty.
    expect(await gitStatus()).toContain(record!);

    const secondErr = createCaptureSink();
    expect(
      await runCli(["accept", "features/multi.feature"], { rootDir, stdout: createCaptureSink(), stderr: secondErr }),
      secondErr.text(),
    ).toBe(0);
    expect(secondErr.text()).not.toMatch(/dirty/i);
    expect(recordsIn(featuresDir)).toHaveLength(2);
  });

  it("refuses when a committed record was deleted, because a deleted record cannot be recognised as one", async () => {
    expect(
      await runCli(["run", "features"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() }),
    ).toBe(1);
    expect(
      await runCli(["accept", "features/greeting.feature"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      }),
    ).toBe(0);
    const [record] = recordsIn(featuresDir);
    expect(record).toBeDefined();

    // Commit the record, then run again so the run being frozen is at HEAD
    // and started clean. Everything after this differs from the test above
    // only by the deletion.
    await commitAll("accept greeting");
    expect(await gitStatus()).toBe("");
    expect(
      await runCli(["run", "features"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() }),
    ).toBe(1);

    await rm(path.join(featuresDir, record!));
    // The guard, again: the deletion is what git now reports.
    expect(await gitStatus()).toMatch(/^ ?D /m);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["accept", "features/greeting.feature"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toMatch(/dirty/i);
    expect(stdout.text()).toBe("");
    // Refused before writing anything: the deleted record is still gone,
    // and no replacement was written in its place.
    expect(recordsIn(featuresDir)).toHaveLength(0);
  });
});
