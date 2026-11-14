import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir, writeUrlProgram } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: the `nuka check` findings for a claim step's `events`,
// against tests/fixtures/events-project. Each one names a claim the run
// could only leave unjudged, known before a world starts: no earlier line
// runs the producer (`events-producer-missing`), two candidates ran
// (`events-producer-ambiguous`), a served world names no `{events}`
// (`events-inlet-missing`), and a world nukadoko does not serve
// (`events-unread`). The order rule is checked as a property over
// generated scenarios, each one judged by the rule as docs/spec.md states
// it; the world findings by their exact text.

interface Finding {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly step?: string;
  readonly fix?: string;
}

async function check(rootDir: string, args: readonly string[] = []): Promise<{ exitCode: number; errors: Finding[]; warnings: Finding[] }> {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["check", "--json", ...args], { rootDir, stdout, stderr: createCaptureSink() });
  const report = bySeverity(stdout.text()) as { errors: Finding[]; warnings: Finding[] };
  return { exitCode, errors: report.errors, warnings: report.warnings };
}

const EVENTS_CODES = new Set(["events-producer-missing", "events-producer-ambiguous", "events-inlet-missing", "events-unread"]);

function eventsFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => EVENTS_CODES.has(finding.code));
}

async function writeFeature(rootDir: string, scenarios: readonly (readonly string[])[]): Promise<void> {
  const text = ["Feature: Counts of what the program did", "", ...scenarios.flatMap((lines, index) => [`  Scenario: s${index}`, ...lines.map((line) => `    ${line}`), ""])];
  await writeFile(path.join(rootDir, "features", "events.feature"), text.join("\n"));
}

// What each kind of line binds in the fixture: a step that runs, a claim
// step and the candidates its events key names, or no step at all.
const LINES = {
  get: { text: 'When the client gets "/rooms/7"', runs: "get" },
  post: { text: 'When the client posts to "/scores"', runs: "post" },
  nothing: { text: "When the client does nothing", runs: "nothing" },
  undefined: { text: "When the client hums a tune" },
  writes: { text: "Then nothing was written", claim: "nothing-was-written", key: "writes", of: ["get", "post", "nothing"] },
  inserts: { text: "Then the score row was inserted once", claim: "inserted-once", key: "inserts", of: ["post"] },
} as const;
type Kind = keyof typeof LINES;
const KINDS = Object.keys(LINES) as Kind[];

/** The events findings the order rule gives one scenario: per claim line,
 * the candidates earlier lines ran decide. One ran is silent, two or more
 * is ambiguous, and none is missing unless an undefined line came first. */
function expectedOrder(kinds: readonly Kind[], firstLine: number): { code: string; line: number; step: string }[] {
  const out: { code: string; line: number; step: string }[] = [];
  kinds.forEach((kind, index) => {
    const line = LINES[kind];
    if (!("claim" in line)) return;
    const before = kinds.slice(0, index).map((earlier) => LINES[earlier]);
    const ran = new Set(before.flatMap((earlier) => ("runs" in earlier && (line.of as readonly string[]).includes(earlier.runs) ? [earlier.runs] : [])));
    if (ran.size === 1) return;
    if (ran.size === 0 && before.some((earlier) => !("runs" in earlier) && !("claim" in earlier))) return;
    out.push({ code: ran.size === 0 ? "events-producer-missing" : "events-producer-ambiguous", line: firstLine + index, step: line.claim });
  });
  return out;
}

describe("nuka check: the order of an events producer", () => {
  let rootDir: string;
  beforeAll(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
  });
  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("names a claim line whose producer no earlier line runs, or two earlier lines run, and holds a missing one back behind an undefined line", () =>
    hegel.testAsync(
      async (tc) => {
        const scenarios = tc.draw(gs.arrays(gs.arrays(gs.sampledFrom(KINDS), { minSize: 1, maxSize: 5 }), { minSize: 1, maxSize: 4 }));
        await writeFeature(
          rootDir,
          scenarios.map((kinds) => kinds.map((kind) => LINES[kind].text)),
        );
        let firstLine = 4;
        const expected = scenarios.flatMap((kinds) => {
          const found = expectedOrder(kinds, firstLine);
          firstLine += kinds.length + 2;
          return found;
        });
        const { errors, warnings } = await check(rootDir);
        expect(eventsFindings(warnings)).toEqual([]);
        expect(eventsFindings(errors).map(({ code, line, step }) => ({ code, line, step }))).toEqual(expected);
      },
      { testCases: 25, suppressHealthCheck: [hegel.HealthCheck.TooSlow] },
    ), 300_000);

  it("says which producer is missing and where it runs, and which candidates ran", async () => {
    await writeFeature(rootDir, [
      [LINES.inserts.text, LINES.post.text],
      [LINES.get.text, LINES.post.text, LINES.writes.text],
    ]);
    const { exitCode, errors } = await check(rootDir);
    expect(exitCode).toBe(1);
    expect(eventsFindings(errors)).toEqual([
      {
        code: "events-producer-missing",
        message:
          'Step "inserted-once"\'s events.inserts counts the execution events of step "post", and no earlier line runs it: "post" runs only at or after this line. Each claim on the count is unjudged (producer-not-run)',
        file: "features/events.feature",
        line: 4,
        step: "inserted-once",
        fix: 'Put a line that runs step "post" earlier in the scenario, or, if an earlier line runs the step whose execution events the claim means, list that step in events.inserts.of of step "inserted-once".',
      },
      {
        code: "events-producer-ambiguous",
        message:
          'Step "nothing-was-written"\'s events.writes counts the execution events of one of steps "get", "post", and "nothing", and "get" and "post" each ran earlier in this scenario, so the run cannot choose whose events to count, and each claim on the count is unjudged',
        file: "features/events.feature",
        line: 10,
        step: "nothing-was-written",
        fix: 'Remove or move lines so that exactly one of steps "get" and "post" runs before this line.',
      },
    ]);
  });
});

describe("nuka check: a world that reads no execution events", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
    await writeFeature(rootDir, [[LINES.get.text, LINES.writes.text]]);
  });
  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("is an error for a served world whose program file names no {events}", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.program.ts"),
      'import { defineProgram } from "./nukadoko-shim.js";\nexport default defineProgram({ serve: { command: "node app/server.mjs", ready: "/up" }, env: { PORT: "{port}" } });\n',
    );
    const { exitCode, errors, warnings } = await check(rootDir);
    expect(exitCode).toBe(1);
    expect(eventsFindings(warnings)).toEqual([]);
    expect(eventsFindings(errors)).toEqual([
      {
        code: "events-inlet-missing",
        message:
          'world default: step "nothing-was-written" counts execution events, and the program file names no {events}, so the program has no file to write them to: each claim on a count is unjudged (inlet-unnamed)',
        file: "nukadoko.program.ts",
        fix: 'Name {events} in env of nukadoko.program.ts for world default, such as env: { EXECUTION_EVENTS: "{events}" }, and have the program append its execution events to that file (docs/execution-events.md).',
      },
    ]);
  });

  it("is a warning for a world at a url, which the run still starts", async () => {
    await writeUrlProgram(rootDir, "http://127.0.0.1:9");
    const { exitCode, errors, warnings } = await check(rootDir);
    expect(exitCode).toBe(0);
    expect(eventsFindings(errors)).toEqual([]);
    expect(eventsFindings(warnings)).toEqual([
      {
        code: "events-unread",
        message:
          'world default: step "nothing-was-written" counts execution events, and the program runs at a url, which nukadoko does not start, so nukadoko reads no execution events there: each claim on a count is unjudged (world-unread)',
        file: "nukadoko.program.ts",
        fix: "Run these scenarios in a world nukadoko serves: give world default serve in nukadoko.program.ts, with {events} in env, or select one that has it with --env.",
      },
    ]);
  });

  it("names the worlds the --env flags select, and only those", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.program.ts"),
      [
        'import { defineProgram } from "./nukadoko-shim.js";',
        "export default defineProgram({",
        '  serve: { command: "node app/server.mjs", ready: "/up" },',
        '  env: { PORT: "{port}", EXECUTION_EVENTS: "{events}", ADMIN_TOKEN: "{token}", JOBS_DIR: "{dir}/jobs" },',
        '  environments: { staging: { url: "http://127.0.0.1:9" } },',
        "});",
        "",
      ].join("\n"),
    );
    expect(eventsFindings((await check(rootDir)).warnings)).toEqual([]);
    const staging = await check(rootDir, ["--env", "staging"]);
    expect(eventsFindings(staging.warnings).map((finding) => finding.message.split(":")[0])).toEqual(["world staging"]);
  });

  it("is a warning for a project with no program file", async () => {
    await rm(path.join(rootDir, "nukadoko.program.ts"));
    const { errors, warnings } = await check(rootDir);
    expect(eventsFindings(errors)).toEqual([]);
    expect(eventsFindings(warnings)).toEqual([
      {
        code: "events-unread",
        message:
          'step "nothing-was-written" counts execution events, and the project has no nukadoko.program.ts, so no world starts and nukadoko reads no execution events: each claim on a count is unjudged (world-unread)',
        fix: 'Write nukadoko.program.ts with serve, the command that starts the program, and {events} in env, such as env: { EXECUTION_EVENTS: "{events}" }.',
      },
    ]);
  });

  it("says nothing when no line binds a step that declares events", async () => {
    await writeUrlProgram(rootDir, "http://127.0.0.1:9");
    await writeFeature(rootDir, [[LINES.get.text]]);
    expect(eventsFindings((await check(rootDir)).warnings)).toEqual([]);
  });
});
