import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the `nuka accept` refusal branches accept.test.ts/
// accept-condition.test.ts never reach. The two setup-phase failures ahead
// of any of the seven refusal conditions (config load, an unknown --env),
// the feature target itself (missing, unparseable), no git repository at
// all, no run having ever executed, and two of the *selected run's own*
// git-state refusals (conditions 5 and 7 of src/cli/accept.ts's own header
// list), plus `MissingStepRecordError`, thrown by
// src/accept/render-record.ts when a passed scenario's own step record has
// gone missing from disk between the run and the accept.

const execFileAsync = promisify(execFile);

/** Removes an untracked/modified path from the working tree without
 * creating a commit and without touching HEAD: exactly what's needed to
 * turn a run's own dirty-at-start recording into a *currently* clean tree
 * at the same commit (accept.ts's own refusal conditions 3 vs 7 read two
 * different git snapshots; this is how a test reaches 7 without ever
 * failing 3). `-u` covers the untracked file this file's own dirty-run test
 * creates; ignored paths (`.nukadoko/`) are left alone, since the run's own
 * records must still be on disk for `nuka accept` to read.
 */
async function stashUntracked(dir: string): Promise<void> {
  await execFileAsync("git", ["stash", "-u"], { cwd: dir, encoding: "utf8" });
}

describe("nuka accept: setup-phase failures ahead of any refusal condition", () => {
  it("propagates a config load failure as exit 1 with a stderr message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["accept", "features/greeting.feature"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("typo");
  });

  it("rejects an unknown --env name before the feature is even read", async () => {
    const rootDir = await copyFixtureToTempDir("accept-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["accept", "features/greeting.feature", "--env", "nope"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(1);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).not.toBe("");
    } finally {
      await removeTempDir(rootDir);
    }
  });
});

describe("nuka accept: the feature target itself", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("refuses when the feature file does not exist, before any git state is even read", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["accept", "features/does-not-exist.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("feature file not found");
  });

  it("refuses when the feature file exists but fails to parse", async () => {
    await writeFile(path.join(rootDir, "features", "broken.feature"), "this is not Gherkin at all {{{\n");

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["accept", "features/broken.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("failed to parse feature file");
  });
});

describe("nuka accept: git state refusals below the feature target", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("refuses outside any git repository, naming that there is no commit to record", async () => {
    // rootDir has no .git of its own, but it is nested inside this very
    // repository's own working tree (helpers/fixtures.ts's
    // `tempFixturesRoot`), so git would otherwise walk up and resolve this
    // repository's own commit. GIT_CEILING_DIRECTORIES genuinely reproduces
    // "not a git repository" for this one process's git calls (same
    // technique as run-provenance.test.ts's own "omits git entirely"
    // case), set to rootDir's *parent*: git always checks its starting
    // directory regardless of the ceiling list, so the ceiling has to sit
    // one level up.
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(rootDir);
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["accept", "features/greeting.feature"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(1);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toContain("not a git repository");
    } finally {
      if (previousCeiling === undefined) {
        delete process.env.GIT_CEILING_DIRECTORIES;
      } else {
        process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      }
    }
  });

  it("refuses when no run of the feature has ever executed", async () => {
    await initGitRepo(rootDir);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("no run has ever executed");
  });

  it("refuses when the run being frozen recorded no git state at all", async () => {
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(rootDir);
    let runExit: number;
    try {
      runExit = await runCli(["run", "features/greeting.feature"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      });
    } finally {
      if (previousCeiling === undefined) {
        delete process.env.GIT_CEILING_DIRECTORIES;
      } else {
        process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      }
    }
    expect(runExit).toBe(0);

    // Only now does this become a real git repository: the run above
    // recorded no git state at all, exactly the case this test is for.
    await initGitRepo(rootDir);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("recorded no git state");
  });

  it("refuses when the run being frozen started on a dirty working tree, even though the tree is clean now", async () => {
    await initGitRepo(rootDir);
    await writeFile(path.join(rootDir, "scratch.txt"), "never committed");

    const runExit = await runCli(["run", "features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    // Removes scratch.txt from the tree without creating a new commit, so
    // HEAD still matches the run's own recorded commit (condition 6 stays
    // satisfied) while the *current* tree is clean (condition 3 stays
    // satisfied too). That isolates condition 7 (the run's own recorded
    // `git.clean`) as the only thing left to refuse on.
    await stashUntracked(rootDir);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("cannot be frozen as a clean sign-off");
  });
});

describe("nuka accept: a step record missing from disk", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("refuses (MissingStepRecordError) when a passed scenario's own step record can't be read back", async () => {
    await initGitRepo(rootDir);

    const runStdout = createCaptureSink();
    const runExit = await runCli(["run", "features/greeting.feature"], {
      rootDir,
      stdout: runStdout,
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    const scenarioRecord = JSON.parse(runStdout.text().trim().split("\n")[0]!);
    const stepRecordId: string = scenarioRecord.steps[0].step_record_id;
    expect(typeof stepRecordId).toBe("string");

    // accept-project's own .gitignore already excludes `.nukadoko/`, so
    // deleting a record under it never makes the working tree "dirty" by
    // refusal condition 3's own definition. Nothing needs to be committed
    // first.
    await rm(path.join(rootDir, ".nukadoko", "records", "steps", stepRecordId), {
      recursive: true,
      force: true,
    });

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("could not be read from .nukadoko/records/steps");
    expect(stderr.text()).toContain(stepRecordId);
  });
});
