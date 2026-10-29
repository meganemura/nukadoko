import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a claim on a count of execution events under `nuka do`,
// against tests/fixtures/events-project. `--use <step record id>` names
// the producer, and the claim reads the lines its record kept: its
// `events.jsonl`, its `events-late.jsonl`, and the world's copy for the
// kinds the program reported. A `nuka do` of the producer waits, before it
// stops its world, until the step's events are whole or 10 seconds have
// passed, so a later line lands beside its record. The recorded reading
// counts what a live one counts: the property runs one producer under
// `nuka run`, where a Then reads it live, and reads the same record again
// under `nuka do --use`.

async function cli(rootDir: string, args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli([...args], { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

interface Claim {
  readonly actual?: number;
  readonly actual_range?: { readonly at_least: number; readonly at_most: number | null };
  readonly actual_from: string;
  readonly outcome: string;
  readonly reason?: string;
  readonly measured: { readonly step_record_id: string; readonly channel: string } | null;
}

interface DoRecord {
  readonly step_record_id: string;
  readonly status: string;
  readonly claims?: readonly Claim[];
  readonly events_read?: Record<string, { readonly of: unknown; readonly range: unknown; readonly whole: boolean; readonly open: readonly { readonly gap: string }[] }>;
  readonly events_late?: { readonly lines: number; readonly file: string | null; readonly truncated?: true };
  readonly observed: { readonly events?: { readonly whole: boolean; readonly open: readonly { readonly gap: string }[] } | null };
}

/** `nuka do <step>`, and the record it printed. */
async function doStep(rootDir: string, step: string, args: Record<string, unknown>, use: readonly string[] = []): Promise<{ exitCode: number; stderr: string; record: DoRecord }> {
  const { exitCode, stdout, stderr } = await cli(rootDir, ["do", step, "--args", JSON.stringify(args), ...use.flatMap((id) => ["--use", id])]);
  return { exitCode, stderr, record: JSON.parse(stdout) as DoRecord };
}

const WRITES = "count db where op in [insert, update, delete, other], committed true";

describe("nuka do --use: a claim on a count of a recorded step's execution events", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
  });
  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("counts the lines of the step record --use names, and breaks, holds, or stays unjudged as a run would", async () => {
    const post = await doStep(rootDir, "post", { path: "/scores" });
    expect(post.exitCode).toBe(0);
    const id = post.record.step_record_id;

    const written = await doStep(rootDir, "nothing-was-written", {}, [id]);
    expect(written.exitCode).toBe(1);
    expect(written.record.claims).toEqual([
      {
        actual: 2,
        actual_from: `events:post@${id} ${WRITES}`,
        compare: "equal",
        expected: 0,
        expected_from: "literal:nothing",
        expected_text: "nothing",
        outcome: "broken",
        measured: { step_record_id: written.record.step_record_id, channel: "events_read.writes" },
      },
    ]);
    expect(written.record.events_read!.writes).toMatchObject({ of: { step_record_id: id, step: "post", line: null }, range: { at_least: 2, at_most: 2 }, whole: true });

    const inserted = await doStep(rootDir, "inserted-once", {}, [id]);
    expect(inserted.exitCode).toBe(0);
    expect(inserted.record.claims![0]).toMatchObject({ actual: 1, outcome: "held" });

    const read = await doStep(rootDir, "get", { path: "/rooms/7" });
    const nothing = await doStep(rootDir, "nothing-was-written", {}, [read.record.step_record_id]);
    expect(nothing.exitCode).toBe(0);
    expect(nothing.record.claims![0]).toMatchObject({ actual: 0, outcome: "held" });
  });

  it("is unjudged when no --use names a step record of the step the key counts", async () => {
    const { exitCode, record } = await doStep(rootDir, "inserted-once", {});
    expect(exitCode).toBe(1);
    expect(record.claims).toEqual([
      {
        actual_from: "events:post count db where table scores, op insert, committed true",
        compare: "equal",
        expected: 1,
        expected_from: "literal:once",
        expected_text: "once",
        outcome: "unjudged",
        reason: 'events.inserts.of names "post", and no --use value names a step record of it, so nuka do has no execution events to count',
        measured: null,
      },
    ]);
  });

  it("waits before it stops the world, so a line the program wrote late is beside the record, and a later --use counts it", async () => {
    // /slow writes its line 300 ms after it answered, and never at the
    // stop: without the wait, the line would be lost with the program.
    const late = await doStep(rootDir, "get", { path: "/slow" });
    expect(late.exitCode).toBe(0);
    expect(late.record.observed.events).toMatchObject({ whole: false, open: [{ gap: "no-lines" }] });
    expect(late.record.events_late).toEqual({ lines: 1, file: "events-late.jsonl" });
    const lines = readFileSync(path.join(rootDir, ".nukadoko", "do", late.record.step_record_id, "events-late.jsonl"), "utf8").trimEnd().split("\n");
    expect(lines.map((line) => (JSON.parse(line) as { route: string }).route)).toEqual(["/slow"]);

    // The late line closes no-lines; this world never reported a db
    // line, so the absence still is not known.
    const nothing = await doStep(rootDir, "nothing-was-written", {}, [late.record.step_record_id]);
    expect(nothing.record.events_read!.writes).toMatchObject({ lines: 1, whole: false, open: [{ gap: "kind-unreported", kind: "db" }] });
    expect(nothing.record.claims![0]).toMatchObject({ actual_range: { at_least: 0, at_most: null }, outcome: "unjudged" });
  });

  it("leaves a claim on a job that never performed unjudged, after waiting for it", async () => {
    const parked = await doStep(rootDir, "post", { path: "/scores?park=1" });
    expect(parked.record.observed.events).toMatchObject({ whole: false, open: [{ gap: "jobs-pending" }] });
    const inserted = await doStep(rootDir, "inserted-once", {}, [parked.record.step_record_id]);
    expect(inserted.exitCode).toBe(1);
    expect(inserted.record.claims![0]).toMatchObject({ actual_range: { at_least: 1, at_most: null }, outcome: "unjudged" });
    expect(inserted.record.claims![0]!.reason).toMatch(/^the events of post@step-[a-z0-9-]+ are not whole \(jobs-pending\): job [0-9a-f]{16} was enqueued and has not performed, /);
  }, 60_000);

  it("refuses two --use values for one events key, and one whose step neither from nor events names", async () => {
    const first = await doStep(rootDir, "get", { path: "/rooms/7" });
    const second = await doStep(rootDir, "post", { path: "/scores" });
    const both = await cli(rootDir, ["do", "nothing-was-written", "--args", "{}", "--use", first.record.step_record_id, "--use", second.record.step_record_id]);
    expect(both.exitCode).toBe(2);
    expect(both.stderr).toContain(
      `--use: events key "writes" is supplied by both step record ${first.record.step_record_id} (step "get") and step record ${second.record.step_record_id} (step "post"), and nuka do counts the execution events of one step record per key`,
    );
    const unnamed = await cli(rootDir, ["do", "inserted-once", "--args", "{}", "--use", first.record.step_record_id]);
    expect(unnamed.exitCode).toBe(2);
    expect(unnamed.stderr).toContain(`--use ${first.record.step_record_id}: its step "get" is not named by any of this step's \`from\` entries or \`events\` keys`);
  });
});

// Each producer is one a world writes a db line for, so the program has
// reported the kind both readings count in, whichever runs first.
const PRODUCERS = [
  ['When the client gets "/rooms/7"', "get"],
  ['When the client posts to "/scores"', "post"],
  ['When the client posts to "/scores?rollback=1"', "post"],
] as const;
const CLAIMS = [
  ["Then nothing was written", "nothing-was-written"],
  ['Then "scores" was written 1 time', "written-times"],
  ['Then "rankings" was written 2 times', "written-times"],
  ["Then the score row was inserted once", "inserted-once"],
] as const;

describe("a recorded reading counts what the live one counted", () => {
  let rootDir: string;
  beforeAll(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
  });
  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("gives the same range and outcome under nuka do --use as the Then gave under nuka run", () =>
    hegel.testAsync(
      async (tc) => {
        const producer = tc.draw(gs.integers({ minValue: 0, maxValue: PRODUCERS.length - 1 }));
        const claim = tc.draw(gs.integers({ minValue: 0, maxValue: CLAIMS.length - 1 }));
        const [when, producerStep] = PRODUCERS[producer]!;
        const [then, claimStep] = CLAIMS[claim]!;
        // The claim names a step its key counts, or the run would leave it
        // unjudged for another reason than the reading.
        tc.assume(!(claimStep === "written-times" || claimStep === "inserted-once") || producerStep === "post");
        await writeFile(path.join(rootDir, "features", "events.feature"), ["Feature: f", "", "  Scenario: s", `    ${when}`, `    ${then}`, ""].join("\n"));
        await cli(rootDir, ["run"]);
        const [scenario] = latestRunJson(rootDir).scenarios as { steps: { step_record_id: string; claims?: Claim[]; events_read?: Record<string, { range: unknown }> }[] }[];
        const [ran, judged] = scenario!.steps;
        const live = judged!.claims![0]!;
        const args = claimStep === "written-times" ? { table: then.includes("scores") ? "scores" : "rankings", n: then.includes("2") ? 2 : 1 } : {};
        const { record } = await doStep(rootDir, claimStep, args, [ran!.step_record_id]);
        const recorded = record.claims![0]!;
        expect(Object.values(record.events_read!).map((reading) => reading.range)).toEqual(Object.values(judged!.events_read!).map((reading) => reading.range));
        expect([recorded.outcome, recorded.actual, recorded.actual_range]).toEqual([live.outcome, live.actual, live.actual_range]);
      },
      { testCases: 8, suppressHealthCheck: [hegel.HealthCheck.TooSlow, hegel.HealthCheck.FilterTooMuch] },
    ), 300_000);
});
