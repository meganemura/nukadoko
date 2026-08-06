import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  initGitRepo,
  removeTempDir,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: `nuka run`'s own `run_id`/`git` provenance fields end to
// end (m4a-run-provenance task spec, test items 2-5) — companion to
// run.test.ts (matching/skip/record mechanics, neither field), following
// that file's own "each concern gets its own file" convention
// (run-browser.test.ts, run-session.test.ts, run-secrets.test.ts).

function records(stdoutText: string): Record<string, unknown>[] {
  return stdoutText
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("nuka run: run_id", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("is the same on every scenario record one invocation writes, across multiple pickles", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/table.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    // features/table.feature has two scenarios, the second of which fails
    // its own binding (see run.test.ts's own "binds a table..." test) —
    // exit 1 either way, both still get a scenario record.
    expect(exitCode).toBe(1);
    const [first, second] = records(stdout.text());
    expect(records(stdout.text())).toHaveLength(2);

    expect(typeof first!.run_id).toBe("string");
    expect(first!.run_id).toMatch(/^run-\d{8}-\d{6}-[a-z0-9]{4}$/);
    expect(second!.run_id).toBe(first!.run_id);
  });
});

describe("nuka run: git provenance", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("records git.commit (matching `git rev-parse HEAD`) and git.clean: true for an untouched repo", async () => {
    const commit = await initGitRepo(rootDir);

    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const [record] = records(stdout.text());
    expect(record!.git).toEqual({ commit, clean: true });
  });

  it("records git.clean: false once the working tree has an untracked file", async () => {
    await initGitRepo(rootDir);
    await writeFile(path.join(rootDir, "untracked.txt"), "never added or committed");

    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const [record] = records(stdout.text());
    expect((record!.git as { clean: boolean }).clean).toBe(false);
  });

  it("omits git entirely, without failing the run, outside any git repository", async () => {
    // rootDir itself has no .git — but it is nested inside this very repo's
    // own working tree (tests/helpers/fixtures.ts's `tempFixturesRoot`), so
    // git would otherwise walk up and resolve this repository's own commit.
    // GIT_CEILING_DIRECTORIES genuinely reproduces "not a git repository"
    // for this one process's git calls, without moving the fixture outside
    // the tree its own step files depend on for module resolution (that
    // file's own comment) — set to rootDir's *parent* (tempFixturesRoot),
    // not rootDir itself: git always checks its starting directory
    // regardless of the ceiling list ("will not exclude the current working
    // directory", git's own docs for this variable), so the ceiling has to
    // be the directory one level up, which stops the search from crossing
    // any further upward, before it ever reaches this repo's real `.git`.
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(rootDir);
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "features/passing.feature"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(stripRunProgressLines(stderr.text())).toBe("");
      const [record] = records(stdout.text());
      expect(record!.git).toBeUndefined();
    } finally {
      if (previousCeiling === undefined) {
        delete process.env.GIT_CEILING_DIRECTORIES;
      } else {
        process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      }
    }
  });
});
