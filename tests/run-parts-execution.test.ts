import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `ctx.call` actually running a part to completion through
// `nuka run`'s own scenario/pickle path. Every other `nuka run` test
// against tests/fixtures/parts-project only reaches `ctx.call`'s own
// read-only refusal (which fires before a part's own `run` ever starts, so
// no `calls[]` entry is ever built); every part call that actually runs
// and records a `calls[]` entry is otherwise only exercised through `nuka
// do`. This closes that gap.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

describe("nuka run: a part called through a scenario", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("parts-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("runs the part to completion and names it on calls[0]", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/numeric-part.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(1);
    expect(record.steps[0].status).toBe("passed");

    const stepRecord = await readStepRecord(rootDir, record.steps[0].step_record_id as string);
    expect(stepRecord.result).toEqual({ doubled: 42 });
    const calls = stepRecord.calls as ReadonlyArray<{ step: string; args: unknown; result: unknown }>;
    expect(calls).toHaveLength(1);
    // Named by its own vocabulary name, the same naming `ctx.call`'s own
    // refusal errors already use, now reached through the success path.
    expect(calls[0]!.step).toBe("takes-a-number");
    expect(calls[0]!.args).toEqual({ n: 21 });
    expect(calls[0]!.result).toEqual({ doubled: 42 });
  });
});
