import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `ctx.resultOf` end to end against tests/fixtures/
// resultof-project — a pure-step project (no browser, no HTTP server, same
// rationale as run.test.ts's own run-project) covering the whole chain
// mechanism: a later step reading
// an earlier step's validated result and it landing on the step record as
// provenance (`used`), the same step run twice in one scenario returning the
// most recent result, the chain never crossing a scenario boundary and never
// carrying a failed run, `used`'s omission when a step never calls
// `resultOf`, and `nuka do` always seeing `undefined`.
//
// tests/fixtures/resultof-project/features/steps/listing-is-closed.ts's own
// relative import of create-listing.ts is this suite's empirical proof of
// decision 1's module-identity claim (identity is judged by the Step
// object's own reference equality ... vocabulary discovery and imports
// between step files land on the same tsImport module graph, so they
// should coincide — this is what a test must prove). The two
// tests below now pass because `src/discover/discover-steps.ts`
// calls tsx's `register({ namespace })`
// exactly once per discovery run and reuses the scoped `.import()` it
// returns for every file, instead of tsx's `tsImport()` convenience wrapper,
// which mints a fresh namespace/module registration on every call — that
// per-call registration was this suite's original failure mode: a step
// file's own relative import of another step file resolved under a
// *different* registration than discovery's own direct load of that same
// file, so the two never matched with `===`. See discover-steps.ts's own
// header comment for the mechanism.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

describe("ctx.resultOf", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("resultof-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("a step that never calls resultOf has no used field on its step record (bullet 5, independent of module identity)", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/resultof.feature:3"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    // This assertion does not depend on cross-file object identity: it only
    // checks create-listing's own step record, which never calls `ctx.resultOf`
    // at all — passes regardless of the module-identity mechanics described
    // in this file's header comment.
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    const createStepRecord = await readStepRecord(rootDir, record.steps[0].record as string);
    expect(createStepRecord.result).toEqual({ id: "l_first-widget", name: "first-widget" });
    expect(createStepRecord.used).toBeUndefined();
  });

  it("a later step reads the earlier step's validated result; the read is recorded as used", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/resultof.feature:3"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(2);

    const createRecordId = record.steps[0].record as string;
    const closedRecordId = record.steps[1].record as string;

    const closedStepRecord = await readStepRecord(rootDir, closedRecordId);
    expect(closedStepRecord.result).toEqual({ closed: true, name: "first-widget" });
    expect(closedStepRecord.used).toEqual([{ record: createRecordId, step: "create-listing" }]);
  });

  it("the same step run twice in one scenario: resultOf returns the most recent result", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/resultof.feature:7"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(3);

    const secondCreateRecordId = record.steps[1].record as string;
    const closedStepRecord = await readStepRecord(rootDir, record.steps[2].record as string);

    expect(closedStepRecord.result).toEqual({ closed: true, name: "second" });
    expect(closedStepRecord.used).toEqual([{ record: secondCreateRecordId, step: "create-listing" }]);
  });

  it("resultOf never crosses a scenario boundary, and a failed run is never chained", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/resultof-boundary.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);

    const [failedScenario, freshScenario] = records;
    expect(failedScenario.status).toBe("failed");
    expect(failedScenario.steps[0].status).toBe("failed");
    const failedStepRecord = await readStepRecord(rootDir, failedScenario.steps[0].record);
    expect(failedStepRecord.status).toBe("failed");
    expect((failedStepRecord as { error: { message: string } }).error.message).toBe(
      "listing creation failed on purpose",
    );

    // A fresh scenario's own chain starts empty regardless of what happened
    // in an earlier scenario — the referenced step never ran in *this*
    // scenario, and even if it had run and failed elsewhere, a failed run
    // never becomes readable.
    expect(freshScenario.status).toBe("passed");
    expect(freshScenario.steps[0].status).toBe("passed");
    const freshStepRecord = await readStepRecord(rootDir, freshScenario.steps[0].record);
    expect(freshStepRecord.result).toEqual({ closed: false, name: null });
    expect(freshStepRecord.used).toBeUndefined();
  });

  it("a failed step's step record carries the ctx.resultOf-read value's own result", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/resultof.feature:12"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(2);

    const createRecordId = record.steps[0].record as string;
    const explodeStepRecord = await readStepRecord(rootDir, record.steps[1].record as string);

    expect(explodeStepRecord.status).toBe("failed");
    expect(explodeStepRecord.used).toEqual([
      { record: createRecordId, step: "create-listing", result: { id: "l_first-widget", name: "first-widget" } },
    ]);
  });

  it("nuka do: ctx.resultOf is always undefined", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "listing-is-closed", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.result).toEqual({ closed: false, name: null });
    expect(stepRecord.used).toBeUndefined();
  });
});
