import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStepRecord } from "../src/record/read-step-record.js";
import type { StepRecord } from "../src/record/types.js";

describe("readStepRecord", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-read-step-record-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a valid record.json back", async () => {
    const stepRecord: StepRecord = {
      step_record_id: "step-20260801-143022-a1b2",
      step: "noop",
      kind: "do",
      args: {},
      result: { ok: true },
      status: "ok",
      environment: "default",
      session: null,
      scenario_record_id: null,
      run_id: null,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      evidence: { dir: ".nukadoko/records/steps/step-20260801-143022-a1b2", screenshots: [] },
      observed: { http_reads: 0, http_writes: 0 },
      mutates: true,
    };
    await writeFile(path.join(dir, "record.json"), `${JSON.stringify(stepRecord, null, 2)}\n`);

    expect(readStepRecord(dir)).toEqual(stepRecord);
  });

  it("returns null when record.json doesn't exist", () => {
    expect(readStepRecord(path.join(dir, "missing"))).toBeNull();
  });

  it("returns null when record.json isn't valid JSON", async () => {
    await writeFile(path.join(dir, "record.json"), "not json{{{");
    expect(readStepRecord(dir)).toBeNull();
  });
});
