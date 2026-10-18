import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  latestRunDir,
  createCaptureSink,
  initGitRepo,
  latestRunJson,
  removeTempDir,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: `nuka run`'s own `run_id`/`commit` provenance fields end
// to end, as run.json and the step records carry them. Companion to
// run.test.ts (matching/skip/record mechanics, neither field), following
// that file's own "each concern gets its own file" convention
// (run-browser.test.ts, run-session.test.ts, run-secrets.test.ts).

describe("nuka run: run_id", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("is run.json's own run_id, and the same on every step record its scenarios cite, across multiple pickles", async () => {
    const exitCode = await runCli(["run", "--no-check", "features/table.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });

    // features/table.feature has two scenarios, the second of which fails
    // its own binding (see run.test.ts's own "binds a table..." test), so
    // the run exits 1 and run.json still holds both.
    expect(exitCode).toBe(1);
    const document = latestRunJson(rootDir);
    expect(document.run_id).toMatch(/^run-\d{8}-\d{6}-[a-z0-9]{4}$/);
    expect(document.scenarios).toHaveLength(2);
    const records = (document.scenarios as { steps: { record: string | null }[] }[])
      .flatMap((scenario) => scenario.steps)
      .flatMap((step) => (step.record === null ? [] : [step.record]));
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      const stepRecord = JSON.parse(readFileSync(path.join(latestRunDir(rootDir), record, "record.json"), "utf8")) as { run_id: string };
      expect(stepRecord.run_id).toBe(document.run_id);
    }
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

  it("records commit.sha (matching `git rev-parse HEAD`) and commit.dirty: false for an untouched repo", async () => {
    const commit = await initGitRepo(rootDir);

    const exitCode = await runCli(["run", "--no-check", "features/passing.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    expect(latestRunJson(rootDir).commit).toEqual({ sha: commit, dirty: false });
  });

  it("records commit.dirty: true once the working tree has an untracked file", async () => {
    await initGitRepo(rootDir);
    await writeFile(path.join(rootDir, "untracked.txt"), "never added or committed");

    const exitCode = await runCli(["run", "--no-check", "features/passing.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    expect(latestRunJson(rootDir).commit.dirty).toBe(true);
  });

  it("writes commit: null, without failing the run, outside any git repository", async () => {
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
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "--no-check", "features/passing.feature"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(stripRunProgressLines(stderr.text())).toBe("");
      expect(latestRunJson(rootDir).commit).toBe(null);
    } finally {
      if (previousCeiling === undefined) {
        delete process.env.GIT_CEILING_DIRECTORIES;
      } else {
        process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      }
    }
  });
});
