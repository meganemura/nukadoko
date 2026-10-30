import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the program's tables list end to end, against
// tests/fixtures/events-project, whose `/dashboard` page fills a cache
// (`solid_cache_entries`, which app/list.mjs marks as infrastructure) and
// records the visit (`events`, marked as bookkeeping) on a GET. A claim on
// a count whose selection names no table leaves those lines out, under
// `nuka run`, at the base of `nuka run --base`, and under `nuka do --use`
// alike, and its record and its line say which lines it left out and why;
// a selection that names the table counts it; without the list the same
// claim breaks on them; and a list that was not read leaves the claim
// unjudged rather than counting either way.

async function cli(rootDir: string, args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli([...args], { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

const program = (extra = "", lists = 'lists: { tables: "node app/list.mjs tables {url}" },'): string =>
  [
    'import { defineProgram } from "./nukadoko-shim.js";',
    "",
    "export default defineProgram({",
    '  serve: { command: "node app/server.mjs", ready: "/up" },',
    `  env: { PORT: "{port}", EXECUTION_EVENTS: "{events}", JOBS_DIR: "{dir}/jobs"${extra} },`,
    `  ${lists}`,
    "});",
    "",
  ].join("\n");

// A count of one table's writes, of the GET before it.
const PAGE_WROTE = `import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import get from "./get.js";

export default defineStep({
  pattern: "the page wrote to {table:string} {n:int} time(s)",
  args: z.object({ table: z.string(), n: z.number() }),
  timeout: 1500,
  events: { writes: { of: get, count: { kind: "db", table: { sentence: "table" }, op: ["insert", "update", "delete", "other"], committed: true } } },
  claims: [{ actual: "writes", compare: "equal", expected: "n" }],
});
`;

const FEATURE = [
  "Feature: A dashboard",
  "",
  "  Scenario: a dashboard is read",
  '    When the client gets "/dashboard"',
  "    Then nothing was written",
  '    And the page wrote to "events" 1 time',
  "",
].join("\n");

const WRITES = "count db where op in [insert, update, delete, other], committed true";
const LEFT_OUT = [
  { kind: "db", fields: { op: "insert", table: "events" }, lines: 1, holds: "bookkeeping" },
  { kind: "db", fields: { op: "insert", table: "solid_cache_entries" }, lines: 1, holds: "infrastructure" },
];

interface Claim {
  readonly actual?: number;
  readonly actual_range?: unknown;
  readonly counted?: unknown;
  readonly left_out?: unknown;
  readonly outcome: string;
  readonly reason?: string;
  readonly after_world_stop?: unknown;
}

interface Step {
  readonly step_record_id: string;
  readonly claims?: readonly Claim[];
  readonly events_read?: Record<string, { readonly counted: unknown; readonly left_out?: unknown; readonly maybe: Record<string, number> }>;
}

function stepsOf(rootDir: string, world = "head", name = "a dashboard is read"): readonly Step[] {
  const scenario = (latestRunJson(rootDir).scenarios as { scenario: string; world?: string; steps: Step[] }[]).find((entry) => (entry.world ?? "head") === world && entry.scenario === name)!;
  return scenario.steps;
}

describe("a count under the program's tables list", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
    await writeFile(path.join(rootDir, "features", "steps", "page-wrote.ts"), PAGE_WROTE);
    await writeFile(path.join(rootDir, "features", "events.feature"), FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("leaves out the bookkeeping and infrastructure writes of a selection that names no table, and says so, and counts them where the selection names the table", async () => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), program());
    const { exitCode, stderr } = await cli(rootDir, ["run"]);
    expect(exitCode, stderr).toBe(0);
    const [, nothing, events] = stepsOf(rootDir);
    expect(nothing!.claims![0]).toMatchObject({ actual: 0, counted: [], left_out: LEFT_OUT, outcome: "held" });
    expect(nothing!.claims![0]).not.toHaveProperty("after_world_stop");
    expect(nothing!.events_read!.writes).toMatchObject({ counted: [], left_out: LEFT_OUT });
    // Naming the table means the table, whatever it holds.
    expect(events!.claims![0]).toMatchObject({ actual: 1, counted: [{ kind: "db", fields: { op: "insert", table: "events" }, lines: 1 }], outcome: "held" });
    expect(events!.claims![0]).not.toHaveProperty("left_out");

    const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8").split("\n");
    expect(summary).toContain(
      `  - 0 (events:get@4 ${WRITES}) equal 0 (literal:nothing) held; left out 2 lines: 1 db insert into events (bookkeeping), 1 db insert into solid_cache_entries (infrastructure); measured: events_read.writes`,
    );
    // A worker under --concurrency reads the list from the world it is
    // given, and two feature files give it two workers to start.
    await writeFile(path.join(rootDir, "features", "second.feature"), FEATURE.replace("a dashboard is read", "a dashboard is read again"));
    const concurrent = await cli(rootDir, ["run", "--concurrency", "2"]);
    expect(concurrent.exitCode, concurrent.stderr).toBe(0);
    expect(stepsOf(rootDir, "head", "a dashboard is read again")[1]!.claims![0]).toMatchObject({ actual: 0, left_out: LEFT_OUT, outcome: "held" });
    expect(stepsOf(rootDir)[1]!.claims![0]).toMatchObject({ actual: 0, left_out: LEFT_OUT, outcome: "held" });
  });

  it("breaks the same claim on those writes when the program declares no tables list", async () => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), program("", ""));
    const { exitCode, stderr } = await cli(rootDir, ["run"]);
    expect(exitCode).toBe(1);
    const [, nothing] = stepsOf(rootDir);
    expect(nothing!.claims![0]).toMatchObject({ actual: 2, outcome: "broken" });
    expect(nothing!.claims![0]).not.toHaveProperty("left_out");
    expect(stderr).toContain(
      `claim broken: 2 (events:get@4 ${WRITES}) equal 0 (literal:nothing); counted 2 lines: 1 db insert into events, 1 db insert into solid_cache_entries\n`,
    );
  });

  it("leaves the claim unjudged when the tables list was not read, since any write may be on a table it leaves out", async () => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), program(', LIST_MODE: "fail"'));
    await writeFile(
      path.join(rootDir, "features", "events.feature"),
      [FEATURE, "  Scenario: one table is counted", '    When the client gets "/dashboard"', '    Then the page wrote to "events" 1 time', ""].join("\n"),
    );
    const { exitCode, stderr } = await cli(rootDir, ["run"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("program-list-unread");
    const [, nothing] = stepsOf(rootDir);
    const [, events] = stepsOf(rootDir, "head", "one table is counted");
    expect(nothing!.claims![0]).toMatchObject({
      actual_range: { at_least: 0, at_most: 2 },
      outcome: "unjudged",
      reason: "2 lines may be on tables the count leaves out, so the count is between 0 and 2, and equal 0 is not known",
    });
    expect(nothing!.events_read!.writes!.maybe).toMatchObject({ holds_unknown: 2 });
    // A selection that names its table needs no list.
    expect(events!.claims![0]).toMatchObject({ actual: 1, outcome: "held" });
  });

  it("reads the same list under nuka do --use, and leaves the same lines out", async () => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), program());
    const get = await cli(rootDir, ["do", "get", "--args", JSON.stringify({ path: "/dashboard" })]);
    expect(get.exitCode, get.stderr).toBe(0);
    const id = (JSON.parse(get.stdout) as { step_record_id: string }).step_record_id;
    // The GET counts nothing, so its world read no tables list.
    expect(get.stderr).not.toContain("lists started");
    const written = await cli(rootDir, ["do", "nothing-was-written", "--args", "{}", "--use", id]);
    expect(written.exitCode, written.stderr).toBe(0);
    expect(written.stderr).toContain("lists started: node app/list.mjs tables");
    expect((JSON.parse(written.stdout) as Step).claims![0]).toMatchObject({ actual: 0, left_out: LEFT_OUT, outcome: "held" });
  });
});

describe("a count at the base under the base's own tables list", () => {
  let rootDir: string;

  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: rootDir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
    // A tree is checked out under the run directory, so the shim's relative
    // path would not reach the source from there.
    writeFileSync(path.join(rootDir, "nukadoko-shim.ts"), `export * from ${JSON.stringify(path.resolve("src/index.js"))};\n`);
    writeFileSync(path.join(rootDir, ".gitignore"), ".nukadoko/\n");
    writeFileSync(path.join(rootDir, "features", "steps", "page-wrote.ts"), PAGE_WROTE);
    writeFileSync(path.join(rootDir, "nukadoko.program.ts"), program());
    writeFileSync(path.join(rootDir, "features", "events.feature"), ["Feature: A dashboard", "", "  Scenario: a room is read", '    When the client gets "/rooms/7"', ""].join("\n"));
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("branch", "base-branch");
    // The change under review adds the criterion, so the base world runs
    // it as a cell, under the base tree's own program file.
    writeFileSync(path.join(rootDir, "features", "events.feature"), FEATURE);
    git("commit", "-q", "-am", "head");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("leaves out at the base what head leaves out, from the list the base's world read", async () => {
    const { stderr } = await cli(rootDir, ["run", "--base", "base-branch"]);
    const worlds = latestRunJson(rootDir).worlds as { name: string; tree: string; lists?: unknown }[];
    expect(worlds.find((world) => world.tree === "base")!.lists, stderr).toEqual({ tables: { entries: 5, error: null } });
    const [, nothing] = stepsOf(rootDir, "base");
    expect(nothing!.claims![0]).toMatchObject({ actual: 0, left_out: LEFT_OUT, outcome: "held" });
  });
});
