import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateReceiptId } from "../src/receipt/receipt-id.js";
import type { Receipt } from "../src/receipt/types.js";
import { writeReceipt } from "../src/receipt/write-receipt.js";

describe("generateReceiptId", () => {
  it("matches rcpt-<YYYYMMDD-HHMMSS>-<4 alphanumeric>", () => {
    const id = generateReceiptId(new Date("2026-08-01T14:30:22"));
    expect(id).toMatch(/^rcpt-\d{8}-\d{6}-[a-z0-9]{4}$/);
    expect(id.startsWith("rcpt-20260801-143022-")).toBe(true);
  });

  it("produces different ids on successive calls", () => {
    const a = generateReceiptId();
    const b = generateReceiptId();
    expect(a).not.toBe(b);
  });
});

describe("writeReceipt", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-receipt-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes receipt.json under the given directory", async () => {
    const receipt: Receipt = {
      receipt_id: "rcpt-20260801-143022-a1b2",
      step: "noop",
      kind: "do",
      args: {},
      result: {},
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

    await writeReceipt(dir, receipt);

    const file = path.join(dir, "receipt.json");
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(await readFile(file, "utf8"));
    expect(parsed).toEqual(receipt);
  });
});
