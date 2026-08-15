import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `ctx.poll`'s step-record-side recording end to end, against
// tests/fixtures/polls-project — a no-op wait
// (attempts: 1) reading differently from a genuinely retried one (attempts
// >= 2, waited_ms > 0), a timed-out or throwing poll still landing on the
// failed step's own step record (the whole reason this field exists), omission
// when a step never calls it, the `beginStep` reset not letting one step's
// polls bleed into a sibling's within the same `nuka run` pickle, `nuka do`
// recording the same way `nuka run` does, and completion order (not call
// order) for more than one poll in a single step. `tests/poll.test.ts`
// covers `ctx.poll`'s own retry-loop behavior; this file is only about what
// lands on the step record.
//
// Each entry's own `at` is checked via
// `expectPollAt` below: not just that it parses as a date, but that it falls
// inside the step record's own `started_at`/`finished_at` span — the same
// ordering check `tests/sections.test.ts` applies to `sections`, since both
// exist to share one timeline.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

/** Checks every `stepRecord.polls[].at` both parses as a date and falls inside
 * this same step record's `started_at`/`finished_at` span (value ordering,
 * not only format — see this file's own
 * header). */
function expectPollAtWithinStepRecord(stepRecord: Record<string, unknown>): void {
  const polls = stepRecord.polls as Array<{ at: string }> | undefined;
  const startedAt = Date.parse(stepRecord.started_at as string);
  const finishedAt = Date.parse(stepRecord.finished_at as string);
  for (const entry of polls ?? []) {
    const at = Date.parse(entry.at);
    expect(Number.isNaN(at)).toBe(false);
    expect(at).toBeGreaterThanOrEqual(startedAt);
    expect(at).toBeLessThanOrEqual(finishedAt);
  }
}

describe("ctx.poll step records", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("polls-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("nuka run: a poll that resolves on the first try records attempts: 1, outcome: resolved", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/polls.feature:3"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    const stepRecord = await readStepRecord(rootDir, record.steps[0].record as string);
    expect(stepRecord.polls).toEqual([
      { at: expect.any(String), attempts: 1, waited_ms: expect.any(Number), outcome: "resolved" },
    ]);
    expectPollAtWithinStepRecord(stepRecord);
  });

  it("nuka run: a poll that retries records attempts >= 2 and waited_ms > 0", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/polls.feature:6"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    const stepRecord = await readStepRecord(rootDir, record.steps[0].record as string);
    const polls = stepRecord.polls as Array<{ attempts: number; waited_ms: number; outcome: string }>;
    expect(polls).toHaveLength(1);
    expect(polls[0]!.attempts).toBeGreaterThanOrEqual(2);
    expect(polls[0]!.waited_ms).toBeGreaterThan(0);
    expect(polls[0]!.outcome).toBe("resolved");
  });

  it("nuka run: a poll that times out fails the step and records outcome: timed_out", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/polls.feature:9"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    const stepRecord = await readStepRecord(rootDir, record.steps[0].record as string);
    expect(stepRecord.status).toBe("failed");
    const polls = stepRecord.polls as Array<{ outcome: string }>;
    expect(polls).toHaveLength(1);
    expect(polls[0]!.outcome).toBe("timed_out");
  });

  it("nuka run: a poll whose fn throws fails the step and records outcome: failed", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/polls.feature:12"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    const stepRecord = await readStepRecord(rootDir, record.steps[0].record as string);
    expect(stepRecord.status).toBe("failed");
    const polls = stepRecord.polls as Array<{ attempts: number; outcome: string }>;
    expect(polls).toHaveLength(1);
    expect(polls[0]!.outcome).toBe("failed");
    expect(polls[0]!.attempts).toBe(1);
  });

  it("nuka run: a step that never calls ctx.poll has no polls key on its step record", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/polls.feature:15"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    const stepRecord = await readStepRecord(rootDir, record.steps[0].record as string);
    expect(stepRecord.polls).toBeUndefined();
    expect(Object.keys(stepRecord)).not.toContain("polls");
  });

  it("nuka run: polls do not bleed across steps sharing one scenario's ctx (beginStep reset regression)", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/polls.feature:18"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(2);

    const alphaStepRecord = await readStepRecord(rootDir, record.steps[0].record as string);
    const betaStepRecord = await readStepRecord(rootDir, record.steps[1].record as string);

    expect(alphaStepRecord.polls).toEqual([
      {
        description: "alpha-only",
        at: expect.any(String),
        attempts: 1,
        waited_ms: expect.any(Number),
        outcome: "resolved",
      },
    ]);
    expect(betaStepRecord.polls).toEqual([
      {
        description: "beta-only",
        at: expect.any(String),
        attempts: 1,
        waited_ms: expect.any(Number),
        outcome: "resolved",
      },
    ]);
    expectPollAtWithinStepRecord(alphaStepRecord);
    expectPollAtWithinStepRecord(betaStepRecord);
  });

  it("nuka run: multiple polls in one step land in completion order, not call order", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/polls.feature:22"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    const stepRecord = await readStepRecord(rootDir, record.steps[0].record as string);
    const polls = stepRecord.polls as Array<{ description?: string }>;
    expect(polls).toHaveLength(2);
    // The outer poll is called first, but its own `fn` awaits the inner
    // poll before returning — the inner poll finishes first and is recorded
    // first, even though it was called second.
    expect(polls.map((entry) => entry.description)).toEqual(["inner", "outer"]);
  });

  it("nuka do: ctx.poll calls land on the step record the same way as under nuka run", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "poll-resolves-first-try", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("ok");
    expect(stepRecord.polls).toEqual([
      { at: expect.any(String), attempts: 1, waited_ms: expect.any(Number), outcome: "resolved" },
    ]);
    expectPollAtWithinStepRecord(stepRecord);
  });

  it("nuka do: a step that never calls ctx.poll has no polls key on its step record", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "no-polls", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("ok");
    expect(stepRecord.polls).toBeUndefined();
  });
});
