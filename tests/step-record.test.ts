import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateStepRecordId } from "../src/record/record-id.js";
import type { StepRecord } from "../src/record/types.js";
import { writeStepRecord } from "../src/record/write-step-record.js";

describe("generateStepRecordId", () => {
  it("matches step-<YYYYMMDD-HHMMSS>-<4 alphanumeric>", () => {
    const id = generateStepRecordId(new Date("2026-08-01T14:30:22"));
    expect(id).toMatch(/^step-\d{8}-\d{6}-[a-z0-9]{4}$/);
    expect(id.startsWith("step-20260801-143022-")).toBe(true);
  });

  it("produces different ids on successive calls", () => {
    const a = generateStepRecordId();
    const b = generateStepRecordId();
    expect(a).not.toBe(b);
  });
});

describe("writeStepRecord", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-step-record-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes record.json under the given directory", async () => {
    const stepRecord: StepRecord = {
      record_id: "step-20260801-143022-a1b2",
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
      evidence: { dir: ".nukadoko/records/steps/step-20260801-143022-a1b2", screenshots: [] },
      observed: { http_reads: 0, http_writes: 0 },
      mutates: true,
    };

    await writeStepRecord(dir, stepRecord);

    const file = path.join(dir, "record.json");
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(await readFile(file, "utf8"));
    expect(parsed).toEqual(stepRecord);
  });
});
