import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `ctx.requireEnv`'s receipt-side measurement end to end
// against tests/fixtures/env-reads-project (env-reads-and-mutates-doc task
// spec, item A) — read order + dedup landing on `required_env`, omission
// when a step never calls `requireEnv`, a `MissingEnvError` failure's
// receipt still carrying the name it asked for (the requirement's own
// reason for existing), the reset at `beginStep` not letting one step's
// required names bleed into a sibling's within the same `nuka run` pickle,
// and `nuka do` recording `required_env` the same way `nuka run` does.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readReceipt(rootDir: string, receiptId: string): Promise<Record<string, unknown>> {
  const receiptPath = path.join(rootDir, ".nukadoko", "receipts", receiptId, "receipt.json");
  return JSON.parse(await readFile(receiptPath, "utf8"));
}

describe("ctx.requireEnv / required_env", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("env-reads-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("nuka run: requireEnv calls land on the receipt deduplicated, in first-read order", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/env-reads.feature:3"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    const receipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    expect(receipt.required_env).toEqual(["API_TOKEN", "SECOND_KEY"]);
  });

  it("nuka run: a step that never calls requireEnv has no required_env key on its receipt", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/env-reads.feature:6"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    const receipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    expect(receipt.required_env).toBeUndefined();
    expect(Object.keys(receipt)).not.toContain("required_env");
  });

  it("nuka run: a step that requires a missing env var still reports the name on its failed receipt", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/env-reads.feature:9"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    const receipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    expect(receipt.status).toBe("failed");
    expect(receipt.required_env).toEqual(["MISSING_KEY"]);
    expect((receipt as { error: { message: string } }).error.message).toContain("MISSING_KEY");
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

    const alphaReceipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    const betaReceipt = await readReceipt(rootDir, record.steps[1].receipt as string);

    expect(alphaReceipt.required_env).toEqual(["ALPHA_ONLY"]);
    expect(betaReceipt.required_env).toEqual(["BETA_ONLY"]);
  });

  it("nuka do: requireEnv calls land on the receipt the same way as under nuka run", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "two-env-reads", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const receipt = JSON.parse(stdout.text());
    expect(receipt.status).toBe("ok");
    expect(receipt.required_env).toEqual(["API_TOKEN", "SECOND_KEY"]);
  });

  it("nuka do: a step that never calls requireEnv has no required_env key on its receipt", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "no-env-reads", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const receipt = JSON.parse(stdout.text());
    expect(receipt.status).toBe("ok");
    expect(receipt.required_env).toBeUndefined();
  });
});
