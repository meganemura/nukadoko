import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `ctx.requireEnv`'s step-record-side measurement end to end
// against tests/fixtures/env-reads-project — read order + dedup landing on
// `required_env`, omission
// when a step never calls `requireEnv`, a `MissingEnvError` failure's
// step record still carrying the name it asked for (the requirement's own
// reason for existing), the reset at `beginStep` not letting one step's
// required names bleed into a sibling's within the same `nuka run` pickle,
// and `nuka do` recording `required_env` the same way `nuka run` does.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

describe("ctx.requireEnv / required_env", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("env-reads-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("nuka run: requireEnv calls land on the step record deduplicated, in first-read order", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/env-reads.feature:3"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    const stepRecord = await readStepRecord(rootDir, record.steps[0].record as string);
    expect(stepRecord.required_env).toEqual(["API_TOKEN", "SECOND_KEY"]);
  });

  it("nuka run: a step that never calls requireEnv has no required_env key on its step record", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/env-reads.feature:6"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    const stepRecord = await readStepRecord(rootDir, record.steps[0].record as string);
    expect(stepRecord.required_env).toBeUndefined();
    expect(Object.keys(stepRecord)).not.toContain("required_env");
  });

  it("nuka run: a step that requires a missing env var still reports the name on its failed step record", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/env-reads.feature:9"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    const stepRecord = await readStepRecord(rootDir, record.steps[0].record as string);
    expect(stepRecord.status).toBe("failed");
    expect(stepRecord.required_env).toEqual(["MISSING_KEY"]);
    expect((stepRecord as { error: { message: string } }).error.message).toContain("MISSING_KEY");
  });

  it("nuka run: required_env does not bleed across steps sharing one scenario's ctx (beginStep reset regression)", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/env-reads.feature:12"], {
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

    expect(alphaStepRecord.required_env).toEqual(["ALPHA_ONLY"]);
    expect(betaStepRecord.required_env).toEqual(["BETA_ONLY"]);
  });

  it("nuka do: requireEnv calls land on the step record the same way as under nuka run", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "two-env-reads", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("ok");
    expect(stepRecord.required_env).toEqual(["API_TOKEN", "SECOND_KEY"]);
  });

  it("nuka do: a step that never calls requireEnv has no required_env key on its step record", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "no-env-reads", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("ok");
    expect(stepRecord.required_env).toBeUndefined();
  });
});
