import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `ctx.poll`'s receipt-side recording end to end, against
// tests/fixtures/polls-project (ctx-poll-receipt task spec) — a no-op wait
// (attempts: 1) reading differently from a genuinely retried one (attempts
// >= 2, waited_ms > 0), a timed-out or throwing poll still landing on the
// failed step's own receipt (the whole reason this field exists), omission
// when a step never calls it, the `beginStep` reset not letting one step's
// polls bleed into a sibling's within the same `nuka run` pickle, `nuka do`
// recording the same way `nuka run` does, and completion order (not call
// order) for more than one poll in a single step. `tests/poll.test.ts`
// covers `ctx.poll`'s own retry-loop behavior; this file is only about what
// lands on the receipt.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readReceipt(rootDir: string, receiptId: string): Promise<Record<string, unknown>> {
  const receiptPath = path.join(rootDir, ".nukadoko", "receipts", receiptId, "receipt.json");
  return JSON.parse(await readFile(receiptPath, "utf8"));
}

describe("ctx.poll receipts", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("polls-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("nuka run: a poll that resolves on the first try records attempts: 1, outcome: resolved", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/polls.feature:3"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    const receipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    expect(receipt.polls).toEqual([{ attempts: 1, waited_ms: expect.any(Number), outcome: "resolved" }]);
  });

  it("nuka run: a poll that retries records attempts >= 2 and waited_ms > 0", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/polls.feature:6"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    const receipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    const polls = receipt.polls as Array<{ attempts: number; waited_ms: number; outcome: string }>;
    expect(polls).toHaveLength(1);
    expect(polls[0]!.attempts).toBeGreaterThanOrEqual(2);
    expect(polls[0]!.waited_ms).toBeGreaterThan(0);
    expect(polls[0]!.outcome).toBe("resolved");
  });

  it("nuka run: a poll that times out fails the step and records outcome: timed_out", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/polls.feature:9"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    const receipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    expect(receipt.status).toBe("failed");
    const polls = receipt.polls as Array<{ outcome: string }>;
    expect(polls).toHaveLength(1);
    expect(polls[0]!.outcome).toBe("timed_out");
  });

  it("nuka run: a poll whose fn throws fails the step and records outcome: failed", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/polls.feature:12"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    const receipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    expect(receipt.status).toBe("failed");
    const polls = receipt.polls as Array<{ attempts: number; outcome: string }>;
    expect(polls).toHaveLength(1);
    expect(polls[0]!.outcome).toBe("failed");
    expect(polls[0]!.attempts).toBe(1);
  });

  it("nuka run: a step that never calls ctx.poll has no polls key on its receipt", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/polls.feature:15"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    const receipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    expect(receipt.polls).toBeUndefined();
    expect(Object.keys(receipt)).not.toContain("polls");
  });

  it("nuka run: polls do not bleed across steps sharing one scenario's ctx (beginStep reset regression)", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/polls.feature:18"], {
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

    expect(alphaReceipt.polls).toEqual([
      { description: "alpha-only", attempts: 1, waited_ms: expect.any(Number), outcome: "resolved" },
    ]);
    expect(betaReceipt.polls).toEqual([
      { description: "beta-only", attempts: 1, waited_ms: expect.any(Number), outcome: "resolved" },
    ]);
  });

  it("nuka run: multiple polls in one step land in completion order, not call order", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/polls.feature:22"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    const receipt = await readReceipt(rootDir, record.steps[0].receipt as string);
    const polls = receipt.polls as Array<{ description?: string }>;
    expect(polls).toHaveLength(2);
    // The outer poll is called first, but its own `fn` awaits the inner
    // poll before returning — the inner poll finishes first and is recorded
    // first, even though it was called second.
    expect(polls.map((entry) => entry.description)).toEqual(["inner", "outer"]);
  });

  it("nuka do: ctx.poll calls land on the receipt the same way as under nuka run", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "poll-resolves-first-try", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const receipt = JSON.parse(stdout.text());
    expect(receipt.status).toBe("ok");
    expect(receipt.polls).toEqual([{ attempts: 1, waited_ms: expect.any(Number), outcome: "resolved" }]);
  });

  it("nuka do: a step that never calls ctx.poll has no polls key on its receipt", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "no-polls", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const receipt = JSON.parse(stdout.text());
    expect(receipt.status).toBe("ok");
    expect(receipt.polls).toBeUndefined();
  });
});
