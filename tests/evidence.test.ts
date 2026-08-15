import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import type { StepSummary } from "../src/cli/vocabulary.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `evidence.attach`/`evidence.path` end to end against
// tests/fixtures/evidence-project (P9 task spec) — content actually written
// and landing on the step record with `at`, same name twice both retained,
// `path()` alone never landing on the step record until something is actually
// written there, `path()` twice returning distinct paths, an unsafe name
// refused, the 100-entry cap + `truncated.evidence`, redaction reaching
// `evidence.attachments[].name`/`.file`, `needs`/`needs_browser` staying
// accurate, and no bleed across steps sharing one `nuka run` pickle's ctx.
// The collector's own contract in isolation is tests/evidence-collector.
// test.ts's job; this file is only the step-record-level wiring, the same split
// tests/http-omitted.test.ts/tests/page-network.test.ts already use.

const API_TOKEN = "sekrit-evidence-456";

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readStepRecordFile(rootDir: string, recordId: string): Promise<string> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return readFile(recordPath, "utf8");
}

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readStepRecordFile(rootDir, recordId));
}

describe("evidence.attach / evidence.path: nuka do", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("evidence-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("attach() writes the file into the step record's own directory and lists it with at", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "attach-orders", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("ok");

    const attachments = stepRecord.evidence.attachments as Array<{ name: string; file: string; at: string }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ name: "orders.json", file: "orders.json" });
    expect(Number.isNaN(Date.parse(attachments[0]!.at))).toBe(false);
    const startedAt = Date.parse(stepRecord.started_at);
    const finishedAt = Date.parse(stepRecord.finished_at);
    const at = Date.parse(attachments[0]!.at);
    expect(at).toBeGreaterThanOrEqual(startedAt);
    expect(at).toBeLessThanOrEqual(finishedAt);

    const written = await readFile(path.join(rootDir, stepRecord.evidence.dir, "orders.json"), "utf8");
    expect(written).toBe('{"ok":true}');
  });

  it("keeps both files when the same name is attached twice, never overwriting the first", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "attach-twice", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    const attachments = stepRecord.evidence.attachments as Array<{ name: string; file: string }>;
    expect(attachments).toHaveLength(2);
    expect(attachments.every((entry) => entry.name === "dup.txt")).toBe(true);
    expect(attachments.map((entry) => entry.file).sort()).toEqual(["dup-2.txt", "dup.txt"]);

    const first = await readFile(path.join(rootDir, stepRecord.evidence.dir, "dup.txt"), "utf8");
    const second = await readFile(path.join(rootDir, stepRecord.evidence.dir, "dup-2.txt"), "utf8");
    expect(first).toBe("first");
    expect(second).toBe("second");
  });

  it("omits evidence.attachments entirely when path() was called but nothing was ever written", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "allocate-without-write", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.evidence.attachments).toBeUndefined();
    expect(Object.keys(stepRecord.evidence)).not.toContain("attachments");
  });

  it("lists a path()-allocated file once the step actually writes to it", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "write-to-allocated-path", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    const attachments = stepRecord.evidence.attachments as Array<{ name: string; file: string; at: string }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ name: "dump.csv", file: "dump.csv" });
  });

  it("returns two different paths from two path() calls with the same name", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "allocate-path-twice", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.result.first).not.toBe(stepRecord.result.second);
    expect(path.basename(stepRecord.result.first)).toBe("dump.csv");
    expect(path.basename(stepRecord.result.second)).toBe("dump-2.csv");
  });

  it("refuses a name that could escape the evidence directory, as a step failure", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "attach-unsafe-name", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("failed");
    expect(stepRecord.error.message).toContain("not allowed");
    // No file escaped the evidence directory's own parent.
    const escaped = await readFile(path.join(rootDir, ".nukadoko", "records", "steps", "escape.txt"), "utf8").catch(
      () => null,
    );
    expect(escaped).toBeNull();
  });

  it("caps attachments at 100 and reports the true total on truncated.evidence", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "attach-many", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    expect((stepRecord.evidence.attachments as unknown[]).length).toBe(100);
    expect(stepRecord.truncated).toEqual({ evidence: 105 });
  });

  it("redacts a secret embedded in an attachment's name and file", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "attach-secret", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).not.toContain(API_TOKEN);
    const stepRecord = JSON.parse(stdout.text());
    const attachments = stepRecord.evidence.attachments as Array<{ name: string; file: string }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.name).toContain("{{secret.API_TOKEN}}");
    expect(attachments[0]!.name).not.toContain(API_TOKEN);
    expect(attachments[0]!.file).not.toContain(API_TOKEN);

    const stepRecordText = await readStepRecordFile(rootDir, stepRecord.record_id as string);
    expect(stepRecordText).not.toContain(API_TOKEN);
  });
});

describe("evidence.attach: nuka run", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("evidence-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes and lists an attachment the same way nuka do does", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/evidence.feature:3"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    const stepRecord = await readStepRecord(rootDir, record.steps[0].record as string);
    const attachments = stepRecord.evidence as { attachments?: Array<{ name: string; file: string }> };
    expect(attachments.attachments).toHaveLength(1);
    expect(attachments.attachments![0]).toMatchObject({ name: "orders.json", file: "orders.json" });
  });

  it("does not bleed an attachment across steps sharing one scenario's ctx (beginStep reset regression)", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/evidence.feature:27"], {
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

    const alphaAttachments = (alphaStepRecord.evidence as { attachments?: Array<{ file: string }> }).attachments;
    const betaAttachments = (betaStepRecord.evidence as { attachments?: Array<{ file: string }> }).attachments;
    expect(alphaAttachments).toEqual([expect.objectContaining({ file: "alpha-only.txt" })]);
    expect(betaAttachments).toEqual([expect.objectContaining({ file: "beta-only.txt" })]);
  });
});

describe("nuka steps --json: evidence's needs/needs_browser", () => {
  it("reports needs: ['evidence'] and needs_browser: false for a step that only destructures evidence", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], {
      rootDir: fixture("evidence-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout.text()) as { steps: StepSummary[] };
    const attachOrders = report.steps.find((s) => s.name === "attach-orders");
    expect(attachOrders?.needs).toEqual(["evidence"]);
    expect(attachOrders?.needs_browser).toBe(false);
  });
});
