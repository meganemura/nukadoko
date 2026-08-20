import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run`'s own args-validation failure path for a step
// that also declares `from` (src/run/run-scenario.ts's `fromInjectionHint`),
// distinct from the from-order pre-execution guard (tests/run-from-
// order.test.ts). Three scenarios: a genuine runtime-only requirement that
// both static checks stay silent about (the args key is schema-optional),
// so this step's own execution actually begins and only the runtime zod
// parse catches the missing upstream and names it; a step whose still-
// unfilled from key is not what actually failed, so the hint stays silent
// about it; and a step with no `from` at all, whose failure carries no hint
// suffix. Named distinctly from the pre-execution-guard failures ("never
// began", no step record) covered elsewhere. Against tests/fixtures/
// from-project.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

describe("nuka run: from's own hint on a genuine args validation failure", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("from-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("begins execution (a real step record), fails args validation, and names the still-missing upstream", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/from-injection-hint.feature:3"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(1);
    expect(record.steps[0].status).toBe("failed");
    // A real step record: unlike the pre-execution guard's own failures,
    // this step's own execution actually began. Neither static check saw
    // anything wrong with an optional key.
    const recordId = record.steps[0].step_record_id as string;
    expect(recordId).not.toBeNull();

    const stepRecord = await readStepRecord(rootDir, recordId);
    expect(stepRecord.status).toBe("failed");
    const error = stepRecord.error as { message: string; kind: string };
    expect(error.kind).toBe("args_invalid");
    expect(error.message).toContain("args validation failed");
    // Names the still-missing from key and which step it should have come
    // from, only because a real zod issue landed on that exact key.
    expect(error.message).toContain('"projectId" should come from step "create-project"');
    expect(error.message).toContain("must run earlier in this scenario");
  });

  it("stays silent about an unfilled from key when a different key is what actually failed", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/from-injection-hint.feature:6"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    const stepRecord = await readStepRecord(rootDir, record.steps[0].step_record_id as string);
    const error = stepRecord.error as { message: string; kind: string };
    expect(error.kind).toBe("args_invalid");
    expect(error.message).toContain("args validation failed");
    // `projectId` never resolved either, but it never caused this failure,
    // so it is never named.
    expect(error.message).not.toContain("projectId");
    expect(error.message).not.toContain("should come from step");
  });

  it("adds no hint suffix at all when the failing step declares no from", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/from-injection-hint.feature:9"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    const stepRecord = await readStepRecord(rootDir, record.steps[0].step_record_id as string);
    const error = stepRecord.error as { message: string; kind: string };
    expect(error.kind).toBe("args_invalid");
    expect(error.message).toContain("args validation failed");
    expect(error.message).not.toContain("should come from step");
  });
});
