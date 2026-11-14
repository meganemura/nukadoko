import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run --base` on a change that declares its intent
// in INTENT.md (docs/intent.md): the file's history since the base, each
// row's result, the row that declares each difference, the differences
// nothing declares, and the exit code they set. A scratch copy of
// tests/fixtures/events-project holds the base commit, whose room page
// reports a decision of its own kind, `x_decision`. The change's first
// commit declares the intent; the second makes the room's tier gold, as
// row 1 says, and also writes an audit row for each score, which no row
// says; a third adds a row. Row 2 aims at the score criterion by its tag
// and does not happen there, and row 3 aims at a tag no criterion has.

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

// Lines 3 and 7 of the feature file.
const FEATURE = [
  "Feature: Rooms and scores",
  "",
  "  Scenario: a room page reads the room",
  '    When the client gets "/rooms/7"',
  "",
  "  @scores",
  "  Scenario: a score is placed",
  '    When the client posts to "/scores"',
  "",
].join("\n");

const ROOM = `    emit({ trace, kind: "db", id: newId(), parent: id, table: "rooms", op: "read", rows: 1 });\n`;
const SCORE = `    emit({ trace, kind: "db", id: newId(), parent: id, table: "scores", op: "insert", rows: 1, ids: [42], committed: true });\n`;

// The room's decision, with an id that differs on every line, which no
// row names and so no path counts.
const decided = (tier: string): string =>
  `    emit({ trace, kind: "x_decision", id: newId(), parent: id, x_id: newId(), x_subject: { room: 7 }, x_result: { tier: ${JSON.stringify(tier)}, seats: 4 } });\n`;

const INTENT = [
  "# Intent",
  "",
  "Room 7 becomes a gold room. Scores report to billing.",
  "",
  "| Target | Observation | Before | After |",
  "| --- | --- | --- | --- |",
  "| x_subject.room=7 | x_decision x_result.tier | basic | gold |",
  "| @scores | http method=POST | 0 | 1 |",
  "",
].join("\n");

const LATER_ROW = "| @archived | db table=rooms op=delete | 0 | 1 |\n";

describe("--base on a change that declares its intent", () => {
  let rootDir: string;
  let exitCode: number;
  let stderr: string;
  let document: Record<string, any>;
  let summary: string[];
  let commits: string[];

  beforeAll(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
    writeFileSync(path.join(rootDir, "nukadoko-shim.ts"), `export * from ${JSON.stringify(path.resolve("src/index.js"))};\n`);
    writeFileSync(path.join(rootDir, ".gitignore"), ".nukadoko/\n");
    writeFileSync(path.join(rootDir, "nukadoko.program.ts"), PROGRAM);
    writeFileSync(path.join(rootDir, "features", "events.feature"), FEATURE);
    const server = path.join(rootDir, "app", "server.mjs");
    const source = readFileSync(server, "utf8");
    expect(source.split(ROOM)).toHaveLength(2);
    expect(source.split(SCORE)).toHaveLength(2);
    writeFileSync(server, source.replace(ROOM, `${ROOM}${decided("basic")}`));
    git(rootDir, "init", "-q", "-b", "main");
    git(rootDir, "add", "-A");
    git(rootDir, "commit", "-q", "-m", "base");
    git(rootDir, "branch", "base-branch");
    writeFileSync(path.join(rootDir, "INTENT.md"), INTENT);
    git(rootDir, "add", "INTENT.md");
    git(rootDir, "commit", "-q", "-m", "Declare the intent");
    writeFileSync(
      server,
      source.replace(ROOM, `${ROOM}${decided("gold")}`).replace(SCORE, `${SCORE}    emit({ trace, kind: "db", id: newId(), parent: id, table: "audit_log", op: "insert", rows: 1, committed: true });\n`),
    );
    git(rootDir, "commit", "-q", "-am", "Make room 7 gold");
    writeFileSync(path.join(rootDir, "INTENT.md"), INTENT + LATER_ROW);
    git(rootDir, "commit", "-q", "-am", "Declare one more row");
    commits = git(rootDir, "log", "--reverse", "--format=%H", "base-branch..HEAD").trim().split("\n");
    const sink = createCaptureSink();
    exitCode = await runCli(["run", "--base", "base-branch"], { rootDir, stdout: createCaptureSink(), stderr: sink });
    stderr = sink.text();
    document = latestRunJson(rootDir);
    summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8").split("\n");
  }, 240_000);

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("records when the intent was declared, what changed it after, and what each row came to", () => {
    expect(document.intent).toEqual({
      file: "INTENT.md",
      declared_in: { commit: commits[0], subject: "Declare the intent", first: true },
      changed_after: [{ commit: commits[2], subject: "Declare one more row" }],
      uncommitted: false,
      problems: [],
      rows: [
        {
          row: 1,
          line: 7,
          target: "x_subject.room=7",
          observation: "x_decision x_result.tier",
          before: "basic",
          after: "gold",
          result: "as_intended",
          as_intended: [{ feature: "features/events.feature", line: 3 }],
          not_happening: [],
        },
        {
          row: 2,
          line: 8,
          target: "@scores",
          observation: "http method=POST",
          before: "0",
          after: "1",
          result: "not_happening",
          as_intended: [],
          not_happening: [{ feature: "features/events.feature", line: 7 }],
        },
        { row: 3, line: 9, target: "@archived", observation: "db table=rooms op=delete", before: "0", after: "1", result: "not_reached", as_intended: [], not_happening: [] },
      ],
    });
  });

  it("counts the decision by the fields the intent names, and says which row declares each difference", () => {
    const [base] = document.paths;
    expect(base.criteria.map((criterion: Record<string, any>) => [criterion.line, criterion.result, criterion.explained_by])).toEqual([
      [3, "changed", "intent"],
      [7, "changed", null],
    ]);
    expect(base.criteria[0].steps[0].changed).toEqual([
      { kind: "x_decision", "x_result.tier": "basic", "x_subject.room": 7, intent: 1, a: { at_least: 1, at_most: 1 }, b: { at_least: 0, at_most: 0 } },
      { kind: "x_decision", "x_result.tier": "gold", "x_subject.room": 7, intent: 1, a: { at_least: 0, at_most: 0 }, b: { at_least: 1, at_most: 1 } },
    ]);
    expect(base.criteria[1].steps[0].changed).toEqual([{ kind: "db", table: "audit_log", op: "insert", a: { at_least: 0, at_most: 0 }, b: { at_least: 1, at_most: 1 } }]);
  });

  it("fails the run on the undeclared difference and the row that did not happen, and on nothing else", () => {
    expect(exitCode, stderr).toBe(1);
    expect(document.table.rows.map((row: Record<string, any>) => [row.line, row.verdict])).toEqual([
      [3, "held"],
      [7, "held"],
    ]);
    const base = git(rootDir, "rev-parse", "base-branch").trim();
    expect(document.findings.filter((finding: Record<string, any>) => finding.code.startsWith("intent-")).map((finding: Record<string, any>) => [finding.code, finding.file, finding.line, finding.do])).toEqual([
      ["intent-unintended", "features/events.feature", 7, `nuka run features/events.feature:7 --base ${base}`],
      ["intent-not-happening", "INTENT.md", 8, `nuka run features/events.feature:7 --base ${base}`],
    ]);
    expect(stderr).toContain("failed\tintent-not-happening\tINTENT.md:8\trow 2 of INTENT.md did not happen in features/events.feature:7, which its target names\n");
  });

  it("shows the intent, then the paths with what nothing declares first", () => {
    const start = summary.indexOf("## Intent");
    const end = summary.findIndex((line, index) => index > start && line === "## Findings");
    const section = summary.slice(start, end === -1 ? undefined : end).filter((line) => !line.startsWith("Each criterion below did something else"));
    expect(section).toEqual([
      "## Intent",
      "",
      `\`INTENT.md\` was declared in \`${commits[0]!.slice(0, 12)}\` (Declare the intent), the change's first commit.`,
      `It changed after that in \`${commits[2]!.slice(0, 12)}\` (Declare one more row): the change of intent is part of what is approved.`,
      "",
      "3 rows: 1 as intended, 1 intended but not happening, 1 not reached by the scenarios compared.",
      "",
      "- row 1 `x_subject.room=7` `x_decision x_result.tier`: `basic` → `gold`; as intended in `features/events.feature:3`",
      "- row 2 `@scores` `http method=POST`: `0` → `1`; intended but not happening in `features/events.feature:7`",
      "- row 3 `@archived` `db table=rooms op=delete`: `0` → `1`; not reached by the scenarios compared",
      "",
      '1 criterion compared with the base did something the change does not declare, listed first under "Changed paths".',
      "",
      "## Changed paths",
      "",
      "",
      "### base → head",
      "",
      "2 criteria compared: 2 changed.",
      "Of the 2 unchanged criteria compared, 2 changed.",
      "",
      "Unchanged criteria that did something else at head, which neither the intent nor the feature files ask for:",
      "",
      "- `features/events.feature:7` a score is placed",
      '  - line 8 `the client posts to "/scores"`: writes `audit_log` insert 0 → 1',
      "",
      "Criteria whose differences the intent declares:",
      "",
      "- `features/events.feature:3` a room page reads the room",
      '  - line 4 `the client gets "/rooms/7"`: `x_decision` `x_subject.room=7` `x_result.tier` `"basic"` → `"gold"` (intent row 1)',
      "",
    ]);
  });
});
