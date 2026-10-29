import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: run.json's `paths` against the base, end to end. A
// scratch copy of tests/fixtures/events-project holds two commits: the
// base, and head, whose server also reports a handled cache miss on a
// room's page and an audit row on each score, and whose feature file adds
// a criterion. Both program files name `{events}`, in two environments.
// Each environment's base world is paired with its head world. The new
// criterion is a cell of the base and shows the audit row head writes.
// The two criteria that did not change are no cells of the base, so the
// base runs them for paths alone: the room's path shows the cache miss,
// the audit's Then fails at the base once, with no proof run, and the
// slow writer's claim, which head fails too, is judged again when the base
// world stops, as a cell's is. The table is what it would be without those
// executions.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
}

const PROGRAM = [
  'import { defineProgram } from "./nukadoko-shim.js";',
  "",
  "export default defineProgram({",
  '  serve: { command: "node app/server.mjs", ready: "/up" },',
  '  env: { PORT: "{port}", EXECUTION_EVENTS: "{events}", ADMIN_TOKEN: "{token}", JOBS_DIR: "{dir}/jobs", QUICK_REORDER: "{condition.quick_reorder}" },',
  "  environments: {",
  '    "reorder-off": { conditions: { quick_reorder: false } },',
  '    "reorder-on": { conditions: { quick_reorder: true } },',
  "  },",
  "});",
  "",
].join("\n");

// Lines 3, 6, 10, and 15 of the feature file.
const ROOM = ["  Scenario: a room page reads the room", '    When the client gets "/rooms/7"', ""];
const AUDIT = ["  Scenario: a score is audited", '    When the client posts to "/scores"', '    Then "audit_log" was written 1 time', ""];
// Its claim holds on the lines it has, and the insert `/after` writes
// later breaks it once the world stops: `broke@13`, wherever it runs.
const SLOW = ["  Scenario: a slow writer", '    When the client gets "/rooms/7"', '    And the client gets "/after"', "    Then nothing was written", ""];
const SCORE = ["  Scenario: a score is placed", '    When the client posts to "/scores"', '    Then "scores" was written 1 time', ""];
const feature = (...scenarios: string[][]): string => ["Feature: Rooms and scores", "", ...scenarios.flat()].join("\n");

// Head's server: a room's page also reports a handled cache miss, and a
// score also writes an audit row.
function headServer(source: string): string {
  const room = `    emit({ trace, kind: "db", id: newId(), parent: id, table: "rooms", op: "read", rows: 1 });\n`;
  const score = `    emit({ trace, kind: "db", id: newId(), parent: id, table: "scores", op: "insert", rows: 1, ids: [42], committed: true });\n`;
  expect(source.split(room)).toHaveLength(2);
  expect(source.split(score)).toHaveLength(2);
  return source
    .replace(room, `${room}    emit({ trace, kind: "error", id: newId(), parent: id, class: "CacheMiss", handled: true });\n`)
    .replace(score, `${score}    emit({ trace, kind: "db", id: newId(), parent: id, table: "audit_log", op: "insert", rows: 1, committed: true });\n`);
}

const AUDITED = {
  line: 7,
  text: 'the client posts to "/scores"',
  ran: "both",
  changed: [{ kind: "db", table: "audit_log", op: "insert", a: { at_least: 0, at_most: 0 }, b: { at_least: 1, at_most: 1 } }],
  open: [],
  gaps: { a: [], b: [] },
};

interface Comparison {
  readonly between: { readonly kind: string };
  readonly a: { readonly world: string; readonly environment: string };
  readonly unread: string | null;
  readonly criteria: readonly { readonly line: number; readonly result: string; readonly a: unknown; readonly steps?: unknown }[];
  readonly not_compared: readonly { readonly line: number; readonly reason: string }[];
}

describe("the paths of each environment's base world against its head world", () => {
  let rootDir: string;
  let stderr: string;

  beforeAll(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
    // A tree is checked out under the run directory, so the shim's relative
    // path would not reach the source from there.
    writeFileSync(path.join(rootDir, "nukadoko-shim.ts"), `export * from ${JSON.stringify(path.resolve("src/index.js"))};\n`);
    writeFileSync(path.join(rootDir, ".gitignore"), ".nukadoko/\n");
    writeFileSync(path.join(rootDir, "nukadoko.program.ts"), PROGRAM);
    writeFileSync(path.join(rootDir, "features", "events.feature"), feature(ROOM, AUDIT, SLOW));
    git(rootDir, "init", "-q", "-b", "main");
    git(rootDir, "add", "-A");
    git(rootDir, "commit", "-q", "-m", "base");
    git(rootDir, "branch", "base-branch");
    const server = path.join(rootDir, "app", "server.mjs");
    writeFileSync(server, headServer(readFileSync(server, "utf8")));
    writeFileSync(path.join(rootDir, "features", "events.feature"), feature(ROOM, AUDIT, SLOW, SCORE));
    git(rootDir, "add", "-A");
    git(rootDir, "commit", "-q", "-m", "head");
    const sink = createCaptureSink();
    await runCli(["run", "--base", "base-branch"], { rootDir, stdout: createCaptureSink(), stderr: sink });
    stderr = sink.text();
  }, 180_000);

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("runs the criteria that did not change at the base for paths alone, as no cells and with no proof run", () => {
    const run = latestRunJson(rootDir) as {
      table: { rows: { line: number; cells: { world: string }[] }[] };
      scenarios: { line: number; world?: string; environment: string; for_paths?: unknown }[];
    };
    expect(run.table.rows.map((row) => [row.line, row.cells.map((cell) => cell.world)])).toEqual([
      [3, ["head", "head"]],
      [6, ["head", "head"]],
      [10, ["head", "head"]],
      [15, ["head", "head", "base", "base"]],
    ]);
    const atBase = run.scenarios.filter((scenario) => scenario.world === "base").map((scenario) => [scenario.line, scenario.environment, scenario.for_paths]);
    expect(atBase).toHaveLength(8);
    expect(atBase).toEqual(
      expect.arrayContaining([
        [3, "reorder-off", { outcome: "pass" }],
        [3, "reorder-on", { outcome: "pass" }],
        [6, "reorder-off", { outcome: "fail", line: 8 }],
        [6, "reorder-on", { outcome: "fail", line: 8 }],
        [10, "reorder-off", { outcome: "broke", line: 13 }],
        [10, "reorder-on", { outcome: "broke", line: 13 }],
        [15, "reorder-off", undefined],
        [15, "reorder-on", undefined],
      ]),
    );
    expect(stderr).toContain("base reorder-off  features/events.feature:3  a room page reads the room  (for paths)\n");
    expect(stderr).not.toContain("features/events.feature:15  a score is placed  (for paths)");
    expect(stderr).not.toContain("proof run");
  });

  it("pairs each environment's base with its head, and compares every criterion head ran", () => {
    const run = latestRunJson(rootDir) as { paths: Comparison[] };
    const base = run.paths.filter((comparison) => comparison.between.kind === "base");
    expect(base.map((comparison) => [comparison.a, comparison.unread])).toEqual([
      [{ world: "base", environment: "reorder-off" }, null],
      [{ world: "base", environment: "reorder-on" }, null],
    ]);
    for (const comparison of base) {
      expect(comparison.criteria.map((criterion) => [criterion.line, criterion.result])).toEqual([
        [3, "changed"],
        [6, "changed"],
        [10, "changed"],
        [15, "changed"],
      ]);
      expect(comparison.criteria[0]!.steps).toEqual([
        {
          line: 4,
          text: 'the client gets "/rooms/7"',
          ran: "both",
          changed: [{ kind: "error", class: "CacheMiss", handled: true, a: { at_least: 0, at_most: 0 }, b: { at_least: 1, at_most: 1 } }],
          open: [],
          gaps: { a: [], b: [] },
        },
      ]);
      expect(comparison.criteria[1]).toMatchObject({ a: { outcome: "fail", line: 8 }, steps: [AUDITED] });
      expect(comparison.criteria[2]).toMatchObject({ a: { outcome: "broke", line: 13 }, b: { outcome: "broke", line: 13 }, steps: [{ line: 11, ran: "both" }] });
      expect(comparison.criteria[3]).toMatchObject({ steps: [{ ...AUDITED, line: 16 }] });
      expect(comparison.not_compared).toEqual([]);
    }
  });

  it("lists what changed against the base once, under one heading, before the pair of environments", () => {
    const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8").split("\n");
    const start = summary.indexOf("### base → head");
    expect(summary.slice(start, summary.indexOf("### `reorder-off` → `reorder-on` (`quick_reorder` false → true)"))).toEqual([
      "### base → head",
      "",
      "4 criteria compared: 4 changed.",
      "",
      "- `features/events.feature:3` a room page reads the room, in `reorder-off`, `reorder-on`",
      '  - line 4 `the client gets "/rooms/7"`: errors `CacheMiss` handled 0 → 1',
      "- `features/events.feature:10` a slow writer, in `reorder-off`, `reorder-on`",
      '  - line 11 `the client gets "/rooms/7"`: errors `CacheMiss` handled 0 → 1',
      "- `features/events.feature:6` a score is audited, in `reorder-off`, `reorder-on`",
      '  - line 7 `the client posts to "/scores"`: writes `audit_log` insert 0 → 1',
      "- `features/events.feature:15` a score is placed, in `reorder-off`, `reorder-on`",
      '  - line 16 `the client posts to "/scores"`: writes `audit_log` insert 0 → 1',
      "",
    ]);
  });
});
