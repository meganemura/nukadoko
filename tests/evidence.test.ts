import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import type { StepSummary } from "../src/cli/vocabulary.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `evidence.attach`/`evidence.path` end to end against
// tests/fixtures/evidence-project (P9 task spec) — content actually written
// and landing on the receipt with `at`, same name twice both retained,
// `path()` alone never landing on the receipt until something is actually
// written there, `path()` twice returning distinct paths, an unsafe name
// refused, the 100-entry cap + `truncated.evidence`, redaction reaching
// `evidence.attachments[].name`/`.file`, `needs`/`needs_browser` staying
// accurate, and no bleed across steps sharing one `nuka run` pickle's ctx.
// The collector's own contract in isolation is tests/evidence-collector.
// test.ts's job; this file is only the receipt-level wiring, the same split
// tests/http-omitted.test.ts/tests/page-network.test.ts already use.

const API_TOKEN = "sekrit-evidence-456";

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readReceiptFile(rootDir: string, receiptId: string): Promise<string> {
  const receiptPath = path.join(rootDir, ".nukadoko", "receipts", receiptId, "receipt.json");
  return readFile(receiptPath, "utf8");
}

async function readReceipt(rootDir: string, receiptId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readReceiptFile(rootDir, receiptId));
}

describe("evidence.attach / evidence.path: nuka do", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("evidence-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("attach() writes the file into the receipt's own directory and lists it with at", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "attach-orders", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const receipt = JSON.parse(stdout.text());
    expect(receipt.status).toBe("ok");

    const attachments = receipt.evidence.attachments as Array<{ name: string; file: string; at: string }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ name: "orders.json", file: "orders.json" });
    expect(Number.isNaN(Date.parse(attachments[0]!.at))).toBe(false);
    const startedAt = Date.parse(receipt.started_at);
    const finishedAt = Date.parse(receipt.finished_at);
    const at = Date.parse(attachments[0]!.at);
    expect(at).toBeGreaterThanOrEqual(startedAt);
    expect(at).toBeLessThanOrEqual(finishedAt);

    const written = await readFile(path.join(rootDir, receipt.evidence.dir, "orders.json"), "utf8");
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
    const receipt = JSON.parse(stdout.text());
    const attachments = receipt.evidence.attachments as Array<{ name: string; file: string }>;
    expect(attachments).toHaveLength(2);
    expect(attachments.every((entry) => entry.name === "dup.txt")).toBe(true);
    expect(attachments.map((entry) => entry.file).sort()).toEqual(["dup-2.txt", "dup.txt"]);

    const first = await readFile(path.join(rootDir, receipt.evidence.dir, "dup.txt"), "utf8");
    const second = await readFile(path.join(rootDir, receipt.evidence.dir, "dup-2.txt"), "utf8");
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
    const receipt = JSON.parse(stdout.text());
    expect(receipt.evidence.attachments).toBeUndefined();
    expect(Object.keys(receipt.evidence)).not.toContain("attachments");
  });

  it("lists a path()-allocated file once the step actually writes to it", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "write-to-allocated-path", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const receipt = JSON.parse(stdout.text());
    const attachments = receipt.evidence.attachments as Array<{ name: string; file: string; at: string }>;
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
    const receipt = JSON.parse(stdout.text());
    expect(receipt.result.first).not.toBe(receipt.result.second);
    expect(path.basename(receipt.result.first)).toBe("dump.csv");
    expect(path.basename(receipt.result.second)).toBe("dump-2.csv");
  });

  it("refuses a name that could escape the evidence directory, as a step failure", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "attach-unsafe-name", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const receipt = JSON.parse(stdout.text());
    expect(receipt.status).toBe("failed");
    expect(receipt.error.message).toContain("not allowed");
    // No file escaped the evidence directory's own parent.
    const escaped = await readFile(path.join(rootDir, ".nukadoko", "receipts", "escape.txt"), "utf8").catch(
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
    const receipt = JSON.parse(stdout.text());
    expect((receipt.evidence.attachments as unknown[]).length).toBe(100);
    expect(receipt.truncated).toEqual({ evidence: 105 });
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
    const receipt = JSON.parse(stdout.text());
    const attachments = receipt.evidence.attachments as Array<{ name: string; file: string }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.name).toContain("{{secret.API_TOKEN}}");
    expect(attachments[0]!.name).not.toContain(API_TOKEN);
    expect(attachments[0]!.file).not.toContain(API_TOKEN);

    const receiptText = await readReceiptFile(rootDir, receipt.receipt_id as string);
    expect(receiptText).not.toContain(API_TOKEN);
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
    const receipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    const attachments = receipt.evidence as { attachments?: Array<{ name: string; file: string }> };
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

    const alphaReceipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    const betaReceipt = await readReceipt(rootDir, record.steps[1].receipt as string);

    const alphaAttachments = (alphaReceipt.evidence as { attachments?: Array<{ file: string }> }).attachments;
    const betaAttachments = (betaReceipt.evidence as { attachments?: Array<{ file: string }> }).attachments;
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
    const summaries = JSON.parse(stdout.text()) as StepSummary[];
    const attachOrders = summaries.find((s) => s.name === "attach-orders");
    expect(attachOrders?.needs).toEqual(["evidence"]);
    expect(attachOrders?.needs_browser).toBe(false);
  });
});
