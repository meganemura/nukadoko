import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readReceipt } from "../src/receipt/read-receipt.js";
import type { Receipt } from "../src/receipt/types.js";

describe("readReceipt", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-read-receipt-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a valid receipt.json back", async () => {
    const receipt: Receipt = {
      receipt_id: "rcpt-20260801-143022-a1b2",
      step: "noop",
      kind: "do",
      args: {},
      result: { ok: true },
      status: "ok",
      environment: "default",
      session: null,
      scenario: null,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      evidence: { dir: ".nukadoko/receipts/rcpt-20260801-143022-a1b2", screenshots: [] },
      observed: { http_reads: 0, http_writes: 0 },
      mutates: true,
    };
    await writeFile(path.join(dir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);

    expect(readReceipt(dir)).toEqual(receipt);
  });

  it("returns null when receipt.json doesn't exist", () => {
    expect(readReceipt(path.join(dir, "missing"))).toBeNull();
  });

  it("returns null when receipt.json isn't valid JSON", async () => {
    await writeFile(path.join(dir, "receipt.json"), "not json{{{");
    expect(readReceipt(dir)).toBeNull();
  });
});
