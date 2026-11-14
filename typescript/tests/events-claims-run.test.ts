import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, removeTempDir, writeUrlProgram } from "./helpers/fixtures.js";

// Responsibility: a claim on a count of execution events end to end,
// through `nuka run` against tests/fixtures/events-project, whose server
// and job worker write one line per operation. A Then judges the lines
// the program wrote for the step it names, and never a value step code
// returned: an absence holds only on a reading that is whole, a reading
// that is not whole leaves the claim unjudged with the gap word, a write
// that rolled back does not count, and a line that arrives after the
// claim was judged makes the cell `broke` once the world stops.

async function cli(rootDir: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(args, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

interface ClaimFacts {
  readonly actual?: number;
  readonly actual_range?: { readonly at_least: number; readonly at_most: number | null };
  readonly counted?: readonly { readonly kind: string; readonly fields: Record<string, unknown>; readonly lines: number }[];
  readonly actual_from: string;
  readonly outcome: string;
  readonly reason?: string;
  readonly measured: { readonly step_record_id: string; readonly channel: string } | null;
  readonly after_world_stop?: { readonly lines: number; readonly range: unknown; readonly outcome: string; readonly reason: string };
}

interface StepFacts {
  readonly text: string;
  readonly status: string;
  readonly step_record_id: string;
  readonly record: string;
  readonly claims?: readonly ClaimFacts[];
  readonly events_read?: Record<string, { readonly range: unknown; readonly counted: unknown; readonly whole: boolean; readonly open: readonly { readonly gap: string }[]; readonly file: string | null }>;
}

const WRITES = "count db where op in [insert, update, delete, other], committed true";

/** The steps of each scenario of the latest run, by scenario name. */
function scenariosOf(rootDir: string): Map<string, { readonly status: string; readonly steps: readonly StepFacts[] }> {
  const run = latestRunJson(rootDir);
  return new Map((run.scenarios as { scenario: string; status: string; steps: StepFacts[] }[]).map((scenario) => [scenario.scenario, scenario]));
}

function feature(scenarios: readonly (readonly [string, readonly string[]])[]): string {
  return ["Feature: Counts of what the program did", "", ...scenarios.flatMap(([name, lines]) => [`  Scenario: ${name}`, ...lines.map((line) => `    ${line}`), ""])].join("\n");
}

describe("a claim on a count of execution events, under nuka run", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("holds on a whole reading, breaks on a write, does not count a rolled-back write, and is unjudged with the gap word on a reading that is not whole", async () => {
    await writeFile(
      path.join(rootDir, "features", "events.feature"),
      feature([
        ["a read writes nothing", ['When the client gets "/rooms/7"', "Then nothing was written"]],
        ["a write", ['When the client posts to "/scores"', 'Then "scores" was written 1 time', 'And "rankings" was written 1 time', "And nothing was written"]],
        ["a rolled-back write", ['When the client posts to "/scores?rollback=1"', "Then nothing was written"]],
        ["a step that sends nothing", ["When the client does nothing", "Then nothing was written"]],
        ["a parked job", ['When the client posts to "/scores?park=1"', "Then the score row was inserted once"]],
      ]),
    );
    const { exitCode, stdout } = await cli(rootDir, ["run"]);
    expect(exitCode, stdout).toBe(1);
    const scenarios = scenariosOf(rootDir);

    const read = scenarios.get("a read writes nothing")!;
    expect(read.status).toBe("passed");
    const readClaim = read.steps[1]!;
    expect(readClaim.claims).toEqual([
      {
        actual: 0,
        counted: [],
        actual_from: `events:get@4 ${WRITES}`,
        compare: "equal",
        expected: 0,
        expected_from: "literal:nothing",
        expected_text: "nothing",
        outcome: "held",
        measured: { step_record_id: readClaim.step_record_id, channel: "events_read.writes" },
      },
    ]);
    expect(readClaim.events_read!.writes).toMatchObject({ range: { at_least: 0, at_most: 0 }, whole: true, open: [], file: "events-read.jsonl" });
    // The lines the claim counted are in the claim step's own record.
    const counted = readFileSync(path.join(latestRunDir(rootDir), readClaim.record, "events-read.jsonl"), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as { kind: string });
    expect(counted.map((line) => line.kind)).toEqual(["db", "request"]);

    const write = scenarios.get("a write")!;
    expect(write.status).toBe("failed");
    expect(write.steps.map((step) => step.claims?.map((claim) => [claim.actual, claim.outcome]))).toEqual([undefined, [[1, "held"]], [[1, "held"]], [[2, "broken"]]]);
    expect(write.steps[1]!.claims![0]!.actual_from).toBe("events:post@8 count db where table scores, op in [insert, update, delete, other], committed true");
    expect(write.steps[3]!.claims![0]!.counted).toEqual([
      { kind: "db", fields: { op: "insert", table: "scores" }, lines: 1 },
      { kind: "db", fields: { op: "update", table: "rankings" }, lines: 1 },
    ]);

    const rolledBack = scenarios.get("a rolled-back write")!;
    expect(rolledBack.status).toBe("passed");
    expect(rolledBack.steps[1]!.claims![0]).toMatchObject({ actual: 0, outcome: "held" });

    const sentNothing = scenarios.get("a step that sends nothing")!;
    expect(sentNothing.status).toBe("failed");
    expect(sentNothing.steps[1]!.claims![0]).toEqual({
      actual_range: { at_least: 0, at_most: null },
      counted: [],
      actual_from: `events:nothing@18 ${WRITES}`,
      compare: "equal",
      expected: 0,
      expected_from: "literal:nothing",
      expected_text: "nothing",
      outcome: "unjudged",
      reason:
        "the events of nothing@18 are not whole (no-requests): the step sent the world no request with a traceparent, ran no process, and sent no MCP call, so the count is at least 0, with no upper bound, and equal 0 is not known",
      measured: { step_record_id: sentNothing.steps[1]!.step_record_id, channel: "events_read.writes" },
    });

    const parked = scenarios.get("a parked job")!;
    expect(parked.status).toBe("failed");
    const parkedClaim = parked.steps[1]!.claims![0]!;
    expect(parkedClaim).toMatchObject({ actual_range: { at_least: 1, at_most: null }, outcome: "unjudged" });
    expect(parkedClaim.reason).toMatch(/^the events of post@22 are not whole \(jobs-pending\): job [0-9a-f]{16} was enqueued and has not performed, so the count is at least 1, with no upper bound, and equal 1 is not known$/);
    expect(parked.steps[1]!.events_read!.inserts!.open).toEqual([{ gap: "jobs-pending", job_ids: [expect.stringMatching(/^[0-9a-f]{16}$/)] }]);

    const rows = new Map((latestRunJson(rootDir).table.rows as { name: string; verdict: string; cells: { outcome: string }[] }[]).map((row) => [row.name, row]));
    expect([...rows].map(([name, row]) => [name, row.verdict, row.cells[0]!.outcome])).toEqual([
      ["a read writes nothing", "held", "pass"],
      ["a write", "failed", "fail"],
      ["a rolled-back write", "held", "pass"],
      ["a step that sends nothing", "failed", "broke"],
      ["a parked job", "failed", "broke"],
    ]);
  });

  it("names the lines each count counted, by what they were, in the record, the failure message, and the summary, under every outcome", async () => {
    await writeFile(
      path.join(rootDir, "features", "events.feature"),
      feature([
        ["a page that records a signal", ['When the client gets "/lobby"', "Then nothing was written"]],
        ["a score", ['When the client posts to "/scores"', "Then the score row was inserted once"]],
        ["a parked job", ['When the client posts to "/scores?park=1"', "Then a recalculation was enqueued once"]],
      ]),
    );
    const { exitCode, stderr } = await cli(rootDir, ["run"]);
    expect(exitCode).toBe(1);
    const scenarios = scenariosOf(rootDir);
    // The page's GET broke "nothing was written" with a bookkeeping insert,
    // and the record says which table took it.
    const signal = scenarios.get("a page that records a signal")!.steps[1]!;
    const events = [{ kind: "db", fields: { op: "insert", table: "events" }, lines: 1 }];
    expect(signal.claims![0]).toMatchObject({ actual: 1, counted: events, outcome: "broken" });
    expect(signal.events_read!.writes!.counted).toEqual(events);
    expect(stderr).toContain(`claim broken: 1 (events:get@4 ${WRITES}) equal 0 (literal:nothing); counted 1 line: db insert into events\n`);

    const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8").split("\n");
    expect(summary).toContain(`  - 1 (events:get@4 ${WRITES}) equal 0 (literal:nothing) broken; counted 1 line: db insert into events; measured: events_read.writes`);
    expect(summary).toContain(
      "  - 1 (events:post@8 count db where table scores, op insert, committed true) equal 1 (literal:once) held; counted 1 line: db insert into scores; measured: events_read.inserts",
    );
    const parked = summary.find((line) => line.startsWith("  - at least 1") && line.includes("count job"));
    expect(parked).toMatch(
      /^ {2}- at least 1, with no upper bound \(events:post@12 count job where name ScoreRecalcJob, phase enqueue\) equal 1 \(literal:once\) unjudged: the events of post@12 are not whole \(jobs-pending\): job [0-9a-f]{16} was enqueued and has not performed, so the count is at least 1, with no upper bound, and equal 1 is not known; counted 1 line: job ScoreRecalcJob enqueue; measured: events_read\.enqueued$/,
    );
  });

  it("makes the cell broke once the world stops, when a line of the producer's trace arrived after the claim held", async () => {
    await writeFile(
      path.join(rootDir, "features", "events.feature"),
      // The read before it reports a db line, so the program is one that
      // reports the kind the claim counts.
      feature([["a slow writer", ['When the client gets "/rooms/7"', 'And the client gets "/after"', "Then nothing was written"]]]),
    );
    const { exitCode, stderr } = await cli(rootDir, ["run"]);
    expect(exitCode).toBe(1);
    const run = latestRunJson(rootDir);
    const [scenario] = run.scenarios as { status: string; steps: StepFacts[] }[];
    const late =
      '1 line of the trace of step "get" arrived after this claim was judged on 1 line, and the stop counted 1 more line: db insert into scores; over all 2 lines, the count is exactly 1, so the claim breaks';
    // The scenario passed, so the finding is what says why the run is red.
    expect(stderr).toContain(
      `failed\tclaim-judged-early\tfeatures/events.feature:6\ta slow writer: a claim at line 6 held before every execution event it counts had arrived, so its cell is broke: ${late}\n  do: nuka run features/events.feature:3\n`,
    );
    // The run judged the claim on the lines it had, and the claim held.
    expect(scenario!.status).toBe("passed");
    expect(scenario!.steps[2]!.claims![0]).toMatchObject({
      actual: 0,
      outcome: "held",
      after_world_stop: {
        lines: 2,
        range: { at_least: 1, at_most: 1 },
        outcome: "broken",
        reason: late,
      },
    });
    expect(run.table.rows).toMatchObject([
      {
        name: "a slow writer",
        verdict: "failed",
        cells: [{ outcome: "broke", line: 6, reason: "a claim at line 6 was judged before every execution event it counts had arrived" }],
        reason: "in default, a claim at line 6 was judged before every execution event it counts had arrived",
      },
    ]);
    const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8").split("\n");
    expect(summary).toContain("| failed | `features/events.feature:3` a slow writer | broke@6 |");
    expect(summary).toContain(
      `  - 0 (events:get@5 ${WRITES}) equal 0 (literal:nothing) held; after the world stopped, ${late}, and the cell is broke; measured: events_read.writes`,
    );
  });

  it("refuses a scenario that cannot supply a producer before a world starts, and leaves its claims unjudged under --no-check", async () => {
    await writeFile(
      path.join(rootDir, "features", "events.feature"),
      feature([
        ["two producers", ['When the client gets "/rooms/7"', 'And the client posts to "/scores"', "Then nothing was written"]],
        ["no producer", ["Then the score row was inserted once"]],
      ]),
    );
    const refused = await cli(rootDir, ["run"]);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr.split("\n").filter((line) => line.startsWith("error\t")).map((line) => line.split("\t").slice(1, 3))).toEqual([
      ["events-producer-ambiguous", "features/events.feature:6"],
      ["events-producer-missing", "features/events.feature:9"],
    ]);

    const { exitCode } = await cli(rootDir, ["run", "--no-check"]);
    expect(exitCode).toBe(1);
    const scenarios = scenariosOf(rootDir);
    expect(scenarios.get("two producers")!.steps[2]!.claims![0]).toMatchObject({
      outcome: "unjudged",
      reason: 'events.writes.of names "get" and "post", and each ran earlier in this scenario, so the step cannot choose whose events to count',
      measured: null,
    });
    expect(scenarios.get("no producer")!.steps[0]!.claims![0]).toMatchObject({
      actual_range: { at_least: 0, at_most: null },
      outcome: "unjudged",
      reason:
        "the events of post were not read (producer-not-run): no earlier line of the scenario ran the step whose events are read, so the count is at least 0, with no upper bound, and equal 1 is not known",
    });
  });
});

describe("a claim on a count of execution events in a world at a URL", () => {
  let rootDir: string;
  let server: Server;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
    server = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await removeTempDir(rootDir);
  });

  it("runs, since the check only warns, and is unjudged, saying the events were not read", async () => {
    await writeUrlProgram(rootDir, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await writeFile(path.join(rootDir, "features", "events.feature"), feature([["a read writes nothing", ['When the client gets "/rooms/7"', "Then nothing was written"]]]));
    const { exitCode } = await cli(rootDir, ["run"]);
    expect(exitCode).toBe(1);
    const [scenario] = latestRunJson(rootDir).scenarios as { steps: StepFacts[] }[];
    expect(scenario!.steps[1]!.claims![0]).toMatchObject({
      actual_range: { at_least: 0, at_most: null },
      outcome: "unjudged",
      reason: expect.stringMatching(/^the events of get@4 were not read \(world-unread\): /),
    });
    expect(scenario!.steps[1]!.events_read!.writes).toMatchObject({ whole: false, open: [{ gap: "world-unread" }], file: null });
  });
});
