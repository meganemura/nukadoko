import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `ctx.section` end to end against tests/fixtures/
// sections-project (t3-sections task spec) — call order landing on the
// receipt, omission when a step never calls it, a failed step's receipt
// still carrying the sections it reached before failing (the requirement's
// whole reason for existing), the reset at `beginStep` not letting one
// step's labels bleed into a sibling's within the same `nuka run` pickle,
// and `nuka do` recording sections the same way `nuka run` does.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readReceipt(rootDir: string, receiptId: string): Promise<Record<string, unknown>> {
  const receiptPath = path.join(rootDir, ".nukadoko", "receipts", receiptId, "receipt.json");
  return JSON.parse(await readFile(receiptPath, "utf8"));
}

describe("ctx.section", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("sections-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("nuka run: three ctx.section calls land on the receipt in the order they were called", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/sections.feature:3"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    const receipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    expect(receipt.sections).toEqual(["one", "two", "three"]);
  });

  it("nuka run: a step that never calls ctx.section has no sections key on its receipt", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/sections.feature:6"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    const receipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    expect(receipt.sections).toBeUndefined();
    expect(Object.keys(receipt)).not.toContain("sections");
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
    const receipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    expect(receipt.status).toBe("failed");
    expect(receipt.sections).toEqual(["setup", "working"]);
    // No separate `error.section` field: the array's own last element is
    // "the last stage reached" (this task's spec, decision 2).
    expect((receipt as { error: { section?: unknown } }).error.section).toBeUndefined();
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

    const alphaReceipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    const betaReceipt = await readReceipt(rootDir, record.steps[1].receipt as string);

    expect(alphaReceipt.sections).toEqual(["alpha-only"]);
    expect(betaReceipt.sections).toEqual(["beta-only"]);
  });

  it("nuka do: ctx.section calls land on the receipt the same way as under nuka run", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "three-sections", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const receipt = JSON.parse(stdout.text());
    expect(receipt.status).toBe("ok");
    expect(receipt.sections).toEqual(["one", "two", "three"]);
  });

  it("nuka do: a step that never calls ctx.section has no sections key on its receipt", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "no-sections", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const receipt = JSON.parse(stdout.text());
    expect(receipt.status).toBe("ok");
    expect(receipt.sections).toBeUndefined();
  });
});
