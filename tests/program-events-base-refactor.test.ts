import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run --base` on a change that leaves every
// criterion unchanged, a refactor's shape. Head's program file names
// `{events}`, so the base world is built for run.json's `paths` alone and
// runs each row for paths, with no cell: the table, the verdicts, and the
// exit code are what they are without it. A scratch copy of
// tests/fixtures/events-project holds the base commit; head first only
// adds a comment to the server, so each criterion does the same at the
// base, and then its server also reports a handled cache miss and an
// audit row, which no feature file asks for, so each criterion says that
// nothing accounts for its difference.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
}

const PROGRAM = [
  'import { defineProgram } from "./nukadoko-shim.js";',
  "",
  "export default defineProgram({",
  '  serve: { command: "node app/server.mjs", ready: "/up" },',
  '  env: { PORT: "{port}", EXECUTION_EVENTS: "{events}", JOBS_DIR: "{dir}/jobs" },',
  "});",
  "",
].join("\n");

// Lines 3 and 6 of the feature file.
const FEATURE = [
  "Feature: Rooms and scores",
  "",
  "  Scenario: a room page reads the room",
  '    When the client gets "/rooms/7"',
  "",
  "  Scenario: a score is placed",
  '    When the client posts to "/scores"',
  '    Then "scores" was written 1 time',
  "",
].join("\n");

// Head's server, the second time: a room's page also reports a handled
// cache miss, and a score also writes an audit row.
function changedServer(source: string): string {
  const room = `    emit({ trace, kind: "db", id: newId(), parent: id, table: "rooms", op: "read", rows: 1 });\n`;
  const score = `    emit({ trace, kind: "db", id: newId(), parent: id, table: "scores", op: "insert", rows: 1, ids: [42], committed: true });\n`;
  expect(source.split(room)).toHaveLength(2);
  expect(source.split(score)).toHaveLength(2);
  return source
    .replace(room, `${room}    emit({ trace, kind: "error", id: newId(), parent: id, class: "CacheMiss", handled: true });\n`)
    .replace(score, `${score}    emit({ trace, kind: "db", id: newId(), parent: id, table: "audit_log", op: "insert", rows: 1, committed: true });\n`);
}

interface Run {
  readonly exitCode: number;
  readonly stderr: string;
  readonly document: {
    readonly table: { readonly rows: readonly { readonly line: number; readonly change: string; readonly verdict: string; readonly cells: readonly { readonly world: string; readonly outcome: string }[] }[] };
    readonly scenarios: readonly { readonly line: number; readonly world?: string; readonly for_paths?: unknown }[];
    readonly paths: readonly {
      readonly between: { readonly kind: string };
      readonly unread: string | null;
      readonly criteria: readonly { readonly line: number; readonly result: string; readonly explained_by?: string | null }[];
      readonly not_compared: readonly unknown[];
    }[];
  };
  readonly summary: readonly string[];
}

async function runAgainstBase(rootDir: string): Promise<Run> {
  const stderr = createCaptureSink();
  const exitCode = await runCli(["run", "--base", "base-branch"], { rootDir, stdout: createCaptureSink(), stderr });
  const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8").split("\n");
  return { exitCode, stderr: stderr.text(), document: latestRunJson(rootDir) as Run["document"], summary };
}

function baseSection(summary: readonly string[]): string[] {
  const start = summary.indexOf("### base → head");
  const end = summary.findIndex((line, index) => index > start && line.startsWith("#"));
  return summary.slice(start, end === -1 ? undefined : end);
}

describe("--base on a change that leaves every criterion unchanged", () => {
  let rootDir: string;
  let refactor: Run;
  let changed: Run;

  beforeAll(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
    // A tree is checked out under the run directory, so the shim's relative
    // path would not reach the source from there.
    writeFileSync(path.join(rootDir, "nukadoko-shim.ts"), `export * from ${JSON.stringify(path.resolve("src/index.js"))};\n`);
    writeFileSync(path.join(rootDir, ".gitignore"), ".nukadoko/\n");
    writeFileSync(path.join(rootDir, "nukadoko.program.ts"), PROGRAM);
    writeFileSync(path.join(rootDir, "features", "events.feature"), FEATURE);
    git(rootDir, "init", "-q", "-b", "main");
    git(rootDir, "add", "-A");
    git(rootDir, "commit", "-q", "-m", "base");
    git(rootDir, "branch", "base-branch");
    const server = path.join(rootDir, "app", "server.mjs");
    const source = readFileSync(server, "utf8");
    writeFileSync(server, `// A comment, and nothing else the program does differently.\n${source}`);
    git(rootDir, "commit", "-q", "-am", "refactor");
    refactor = await runAgainstBase(rootDir);
    writeFileSync(server, changedServer(source));
    changed = await runAgainstBase(rootDir);
  }, 240_000);

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("runs each criterion at the base for paths alone, as no cell, so the table, the verdicts, and the exit code do not move", () => {
    for (const run of [refactor, changed]) {
      expect(run.exitCode, run.stderr).toBe(0);
      expect(run.document.table.rows.map((row) => [row.line, row.change, row.verdict, row.cells.map((cell) => `${cell.world}:${cell.outcome}`)])).toEqual([
        [3, "unchanged", "held", ["head:pass"]],
        [6, "unchanged", "held", ["head:pass"]],
      ]);
      expect(run.document.scenarios.filter((scenario) => scenario.world === "base").map((scenario) => [scenario.line, scenario.for_paths])).toEqual([
        [3, { outcome: "pass" }],
        [6, { outcome: "pass" }],
      ]);
      expect(run.stderr).toContain("base default  features/events.feature:3  a room page reads the room  (for paths)\n");
      expect(run.stderr).not.toContain("proof run");
    }
  });

  it("compares each unchanged criterion with the base, and says when each did the same", () => {
    const [base] = refactor.document.paths;
    expect(base).toMatchObject({ between: { kind: "base" }, unread: null, not_compared: [] });
    expect(base!.criteria.map((criterion) => [criterion.line, criterion.result, criterion.explained_by])).toEqual([
      [3, "same", undefined],
      [6, "same", undefined],
    ]);
    expect(baseSection(refactor.summary)).toEqual([
      "### base → head",
      "",
      "2 criteria compared: 2 the same.",
      "Each of the 2 unchanged criteria compared did the same at the base and at head.",
      "",
    ]);
  });

  it("names each unchanged criterion that did something else, which nothing in the feature files accounts for", () => {
    const [base] = changed.document.paths;
    expect(base!.criteria.map((criterion) => [criterion.line, criterion.result, criterion.explained_by])).toEqual([
      [3, "changed", null],
      [6, "changed", null],
    ]);
    expect(baseSection(changed.summary)).toEqual([
      "### base → head",
      "",
      "2 criteria compared: 2 changed.",
      "Of the 2 unchanged criteria compared, 2 changed.",
      "",
      "Unchanged criteria that did something else at head, which nothing in the feature files asks for:",
      "",
      "- `features/events.feature:3` a room page reads the room",
      '  - line 4 `the client gets "/rooms/7"`: errors `CacheMiss` handled 0 → 1',
      "- `features/events.feature:6` a score is placed",
      '  - line 7 `the client posts to "/scores"`: writes `audit_log` insert 0 → 1',
      "",
    ]);
  });
});
