import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { doRelativeDir, runsRelativeDir, stepRecordRelativeDir } from "./state-layout.js";
import type { StepRecord } from "./types.js";

// Responsibility: the read-side counterpart to write-step-record.ts. It
// reads synchronously (`readFileSync`): the allure-js-commons
// `ReporterRuntime`/`Writer` surface that src/report/allure/write-results.ts
// drives is synchronous by contract (every `Writer` method returns `void`),
// and the run summary and `nuka report` read step records on the same
// synchronous path, the convention src/feature/load-features.ts already
// uses for its own filesystem reads.
//
// Takes the step record's own directory directly (mirrors `writeStepRecord
// (evidenceDir, record)`'s own parameter shape) rather than a step record id:
// a caller reading a run already holds the directory run.json names.
// `readStepRecordById` below is the one exception: `nuka do --use` has no
// record to derive a directory from, only a bare id typed on the command
// line, so it is worth this module knowing the convention for that one
// caller.
//
// A missing or unparseable record.json is not this module's failure to
// surface: every read failure (file not found, malformed JSON, any other
// I/O error) collapses to the same `null`, and the caller decides what a
// missing record means for what it renders.

// A record written by nukadoko 0.16.1 or earlier says `"ok"` where it now
// says `"passed"`.
// Such a record stays on disk until retention removes it, and `--use` may
// still name it, so it is read as the word it stands for.
export function readStepRecord(recordDir: string): StepRecord | null {
  try {
    const content = readFileSync(path.join(recordDir, "record.json"), "utf8");
    const record = JSON.parse(content) as StepRecord | (Omit<StepRecord, "status"> & { status: "ok" });
    return record.status === "ok" ? ({ ...record, status: "passed" } as StepRecord) : record;
  } catch {
    return null;
  }
}

// `nuka do --use <record-id>` is the one caller that hands this module a
// step record id typed on the command line rather than one
// this tool already wrote down and is reading back (`readStepRecordsForScenario`,
// src/report/step-records.ts, only ever cites ids its own scenario record
// carries) — so, unlike every other reader here, the id itself is untrusted
// input. A real id is only ever `[a-z0-9-]+` (record-id.ts's own
// `generateId`); rejecting anything else up front, before it is ever joined
// into a path, is what keeps `--use ../../etc/passwd` from resolving outside
// the state directory at all. A rejected id collapses into the same `null` a
// merely-absent one already produces: `--use`'s own caller reports both as
// "no such step record", so a malformed id gets no signal about which
// failure mode it hit.
const VALID_RECORD_ID = /^[a-z0-9-]+$/;

/** `readStepRecord` for an id typed on the command line, which names no
 * run: a `nuka do` record under `<stateDir>/do/<id>`, else the run whose
 * `steps/<id>` holds it. Record ids carry their second and a random
 * suffix, so one id names one directory; the runs are tried in name
 * order, which is the order their ids were drawn. */
export function readStepRecordById(rootDir: string, stateDir: string, recordId: string): StepRecord | null {
  if (!VALID_RECORD_ID.test(recordId)) {
    return null;
  }
  const fromDo = readStepRecord(path.join(rootDir, doRelativeDir(stateDir), recordId));
  if (fromDo !== null) return fromDo;
  let runIds: string[];
  try {
    runIds = readdirSync(path.join(rootDir, runsRelativeDir(stateDir))).sort();
  } catch {
    return null;
  }
  for (const runId of runIds) {
    if (!VALID_RECORD_ID.test(runId)) continue;
    const record = readStepRecord(path.join(rootDir, stepRecordRelativeDir(stateDir, runId, recordId)));
    if (record !== null) return record;
  }
  return null;
}
