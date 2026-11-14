import path from "node:path";
import { readStepRecord } from "../record/read-step-record.js";
import type { StepRecord } from "../record/types.js";
import type { ScenarioRecord } from "../record/scenario-record.js";
import { stepRecordRelativeDir } from "../record/state-layout.js";

// Responsibility: read every record.json a scenario record's own steps
// reference, once per record, for the run.json entry cli/run.ts builds as
// each scenario finishes. Each step record's directory comes from
// src/record/state-layout.ts, the one place that says where a run's step
// records live, rather than from the shape of the scenario's evidence path.
//
// A missing or unparseable record.json collapses to `null`
// (read-step-record.ts itself makes that call); the caller marks that step
// `record_unreadable` so it does not vanish from what the run reports.

export function readStepRecordsForScenario(
  rootDir: string,
  stateDir: string,
  record: ScenarioRecord,
): ReadonlyMap<string, StepRecord | null> {
  const records = new Map<string, StepRecord | null>();
  for (const step of record.steps) {
    if (step.step_record_id !== null && !records.has(step.step_record_id)) {
      records.set(step.step_record_id, readStepRecord(path.join(rootDir, stepRecordRelativeDir(stateDir, record.run_id, step.step_record_id))));
    }
  }
  return records;
}
