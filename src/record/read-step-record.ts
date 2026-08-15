import { readFileSync } from "node:fs";
import path from "node:path";
import type { StepRecord } from "./types.js";

// Responsibility: the read-side counterpart to write-step-record.ts, built
// specifically for src/report/allure/emitter.ts. The whole allure-js-commons
// `ReporterRuntime`/`Writer` surface that emitter drives is synchronous by
// contract (every `Writer` method returns `void`, never a `Promise` —
// verified against allure-js-commons' own `Writer` type), and the emitter's
// own public `emitScenario(...): void` is pinned to that same synchronous
// shape. write-step-record.ts's own `fs/promises` style would force
// `emitScenario` to become `async`,
// contradicting that pinned signature — so this reads synchronously instead
// (`readFileSync`), the same convention src/feature/load-features.ts already
// uses for its own filesystem reads, keeping the emitter's body free of
// `await` end to end.
//
// Takes the step record's own directory directly (mirrors `writeStepRecord
// (evidenceDir, record)`'s own parameter shape) rather than a step record id
// — the id-to-directory convention (`<stateDir>/records/steps/<id>`) belongs
// to src/run/run-scenario.ts, and the caller here (emitter.ts) already has to
// derive that path itself from the scenario record it is reading; growing
// this module's own contract to duplicate that convention isn't worth it for
// a one-line `path.join`. `readStepRecordById` below is the one exception:
// `nuka do --use` has no record to derive a directory from, only a bare id
// typed on the command line, so it is worth this module knowing the
// convention for that one caller.
//
// A missing or unparseable record.json is not this module's failure to
// surface: the emitter's own mapping treats a `null` result as "fall back
// to the record's own coarser status", so every read failure — file not
// found, malformed JSON, any other I/O error — collapses to the same
// `null` rather than being distinguished;
// a caller that cannot act differently on any of them has no use for the
// difference.

export function readStepRecord(recordDir: string): StepRecord | null {
  try {
    const content = readFileSync(path.join(recordDir, "record.json"), "utf8");
    return JSON.parse(content) as StepRecord;
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
// `<stateDir>/records/steps/` at all — same reasoning as session/name.ts's
// own `VALID_SESSION_NAME`. A rejected id collapses into the same `null` a
// merely-absent one already produces: `--use`'s own caller reports both as
// "no such step record", so a malformed id gets no signal about which
// failure mode it hit.
const VALID_RECORD_ID = /^[a-z0-9-]+$/;

/** `readStepRecord` plus the id -> directory convention every writer here
 * already shares (`<stateDir>/records/steps/<id>`, e.g. src/cli/do.ts's own
 * `relativeDir`) — a second `readStepRecord(path.join(...))` call site would
 * otherwise have to know that convention itself. */
export function readStepRecordById(rootDir: string, stateDir: string, recordId: string): StepRecord | null {
  if (!VALID_RECORD_ID.test(recordId)) {
    return null;
  }
  return readStepRecord(path.join(rootDir, stateDir, "records", "steps", recordId));
}
