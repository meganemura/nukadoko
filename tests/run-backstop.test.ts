import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run`'s own general per-step backstop (src/run/
// run-scenario.ts). A step whose own `args`/`returns` validate fine and
// whose own `run()` never throws can still fail once the executor tries to
// turn its validated result into a step record: this step returns a
// BigInt, which `JSON.stringify` cannot serialize. That throw happens
// *after* this step's own step record directory already exists, so it
// lands in the same "began, but never finished" family as any other
// execution-phase failure (docs/spec.md "Running": once a pickle begins
// executing, every step still gets a record entry), not the "never
// began" family undefined/ambiguous steps get. Against tests/fixtures/
// run-project.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

describe("nuka run: the general per-step backstop", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("still writes a failed step record when the validated result can't reach disk, and skips the rest of the scenario", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/bigint-result.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(2);

    const [first, second] = record.steps;
    expect(first.status).toBe("failed");
    // A real step record: this step's own execution had already begun
    // (its own directory already existed) by the time the write itself
    // failed.
    const recordId = first.step_record_id as string;
    expect(recordId).not.toBeNull();
    expect(first.error.message).toContain("BigInt");

    const stepRecord = await readStepRecord(rootDir, recordId);
    expect(stepRecord.status).toBe("failed");
    const error = stepRecord.error as { message: string; kind: string };
    expect(error.kind).toBe("step_error");
    expect(error.message).toContain("BigInt");

    // The rest of the scenario never runs, the same as any other failed step.
    expect(second.status).toBe("skipped");
    expect(second.step_record_id).toBeNull();
  });
});
