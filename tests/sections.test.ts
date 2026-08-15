import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `ctx.section` end to end against tests/fixtures/
// sections-project (t3-sections task spec) — call order landing on the
// step record, omission when a step never calls it, a failed step's step
// record still carrying the sections it reached before failing (the requirement's
// whole reason for existing), the reset at `beginStep` not letting one
// step's labels bleed into a sibling's within the same `nuka run` pickle,
// and `nuka do` recording sections the same way `nuka run` does. Each
// entry's own `at` (fb4-evidence-time task spec, item 3) is checked here
// too: not just that it parses as a date, but that it falls inside the
// step record's own `started_at`/`finished_at` span — a label with a plausible-
// looking but wrong timestamp would still let the misdiagnosis this task's
// spec describes happen again.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

/** Checks `stepRecord.sections` against the expected labels, in order, and that
 * every entry's own `at` both parses as a date and falls inside this same
 * step record's `started_at`/`finished_at` span (fb4-evidence-time task spec: an
 * `at` that merely looks like a timestamp is not enough — it has to be the
 * *right* one). */
function expectSectionLabels(stepRecord: Record<string, unknown>, labels: readonly string[]): void {
  const sections = stepRecord.sections as Array<{ label: string; at: string }> | undefined;
  expect(sections?.map((entry) => entry.label)).toEqual(labels);
  const startedAt = Date.parse(stepRecord.started_at as string);
  const finishedAt = Date.parse(stepRecord.finished_at as string);
  for (const entry of sections ?? []) {
    const at = Date.parse(entry.at);
    expect(Number.isNaN(at)).toBe(false);
    expect(at).toBeGreaterThanOrEqual(startedAt);
    expect(at).toBeLessThanOrEqual(finishedAt);
  }
}

describe("ctx.section", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("sections-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("nuka run: three ctx.section calls land on the step record in the order they were called", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/sections.feature:3"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    const stepRecord = await readStepRecord(rootDir, record.steps[0].record as string);
    expectSectionLabels(stepRecord, ["one", "two", "three"]);
  });

  it("nuka run: a step that never calls ctx.section has no sections key on its step record", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/sections.feature:6"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    const stepRecord = await readStepRecord(rootDir, record.steps[0].record as string);
    expect(stepRecord.sections).toBeUndefined();
    expect(Object.keys(stepRecord)).not.toContain("sections");
  });

  it("nuka run: a step that fails partway still reports the sections it reached before failing", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/sections.feature:9"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    const stepRecord = await readStepRecord(rootDir, record.steps[0].record as string);
    expect(stepRecord.status).toBe("failed");
    expectSectionLabels(stepRecord, ["setup", "working"]);
    // No separate `error.section` field: the array's own last element is
    // "the last stage reached" (this task's spec, decision 2).
    expect((stepRecord as { error: { section?: unknown } }).error.section).toBeUndefined();
  });

  it("nuka run: sections do not bleed across steps sharing one scenario's ctx (beginStep reset regression)", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/sections.feature:12"], {
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

    expectSectionLabels(alphaStepRecord, ["alpha-only"]);
    expectSectionLabels(betaStepRecord, ["beta-only"]);
  });

  it("nuka do: ctx.section calls land on the step record the same way as under nuka run", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "three-sections", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("ok");
    expectSectionLabels(stepRecord, ["one", "two", "three"]);
  });

  it("nuka do: a step that never calls ctx.section has no sections key on its step record", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "no-sections", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("ok");
    expect(stepRecord.sections).toBeUndefined();
  });
});
