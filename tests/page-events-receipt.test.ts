import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  removeTempDir,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: page_events end to end against tests/fixtures/
// page-events-project (P0-page-events task spec) — a real chromium page
// producing a console error, an uncaught error, and a failed request, all
// three landing on the receipt under both `nuka do` and `nuka run`
// (completion condition 3: neither path alone), redacted the same way
// http.jsonl/receipt.json already are (a secret embedded in the console
// text and the failed request's URL), and the field entirely absent — not
// present-but-empty — when a step's page never produces any of the three
// (completion condition 4). PageEventsCollector's own record/reset/cap
// behavior is unit-tested directly in tests/page-events.test.ts; a real
// browser is a poor way to prove a 100-entry cap.

const PAGE_TOKEN = "sekrit-page-token-456";

async function readReceipt(rootDir: string, receiptId: string): Promise<Record<string, unknown>> {
  const receiptPath = path.join(rootDir, ".nukadoko", "receipts", receiptId, "receipt.json");
  return JSON.parse(await readFile(receiptPath, "utf8"));
}

describe("page_events on the receipt", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("page-events-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("nuka do: records console_errors, page_errors, and failed_requests, each redacted", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "trigger-page-events", "--args", "{}"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const receipt = JSON.parse(stdout.text());
    expect(receipt.status).toBe("ok");

    // At least the explicit console.error() call this step made — Chromium
    // also auto-logs an uncaught exception as a console error of its own, so
    // this is >= 1, not exactly 1. Every entry must be redacted regardless
    // of which one Chromium generated on its own.
    const consoleErrors = receipt.page_events.console_errors as Array<{
      text: string;
      location: unknown;
      at: string;
    }>;
    expect(consoleErrors.length).toBeGreaterThanOrEqual(1);
    for (const entry of consoleErrors) {
      expect(entry.text).not.toContain(PAGE_TOKEN);
      expect(entry.location).toBeDefined();
      expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
    }
    expect(consoleErrors.some((entry) => entry.text.includes("{{secret.PAGE_TOKEN}}"))).toBe(true);

    const pageErrors = receipt.page_events.page_errors as Array<{ message: string; at: string }>;
    expect(pageErrors).toHaveLength(1);
    expect(pageErrors[0]!.message).toContain("{{secret.PAGE_TOKEN}}");
    expect(pageErrors[0]!.message).not.toContain(PAGE_TOKEN);

    const failedRequests = receipt.page_events.failed_requests as Array<{
      method: string;
      url: string;
      at: string;
    }>;
    expect(failedRequests).toHaveLength(1);
    expect(failedRequests[0]!.method).toBe("GET");
    expect(failedRequests[0]!.url).toContain("{{secret.PAGE_TOKEN}}");
    expect(failedRequests[0]!.url).not.toContain(PAGE_TOKEN);

    // The raw token must appear nowhere: not in stdout, not in receipt.json
    // on disk (same three-exits check tests/secrets.test.ts already runs
    // for http.jsonl/result).
    expect(stdout.text()).not.toContain(PAGE_TOKEN);
    const receiptPath = path.join(rootDir, receipt.evidence.dir, "receipt.json");
    const receiptText = await readFile(receiptPath, "utf8");
    expect(receiptText).not.toContain(PAGE_TOKEN);
    expect(receiptText).toContain("{{secret.PAGE_TOKEN}}");
  });

  it("nuka run: page_events lands on the step's own receipt", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/page-events.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stripRunProgressLines(stderr.text())).toBe("");
    const lines = stdout.text().split("\n").filter((line) => line.length > 0);
    const record = JSON.parse(lines[0]!);
    expect(record.status).toBe("passed");

    const receipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    expect(receipt.status).toBe("ok");
    const pageEvents = receipt.page_events as {
      console_errors?: unknown[];
      page_errors?: unknown[];
      failed_requests?: unknown[];
    };
    // At least one console error — see the `nuka do` test above for why
    // this is >= 1 rather than exactly 1 (Chromium's own auto-logged
    // uncaught-exception message).
    expect((pageEvents.console_errors ?? []).length).toBeGreaterThanOrEqual(1);
    expect(pageEvents.page_errors).toHaveLength(1);
    expect(pageEvents.failed_requests).toHaveLength(1);
  });

  it("a step whose page never errors carries no page_events key at all", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "quiet-page", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const receipt = JSON.parse(stdout.text());
    expect(receipt.status).toBe("ok");
    expect(receipt.page_events).toBeUndefined();
    expect(Object.keys(receipt)).not.toContain("page_events");
  });
});
