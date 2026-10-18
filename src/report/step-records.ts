import path from "node:path";
import { readStepRecord } from "../record/read-step-record.js";
import type { StepRecord } from "../record/types.js";
import type { ScenarioRecord } from "../record/scenario-record.js";

// Responsibility: read every record.json a scenario record's own steps
// reference, once per record, for the run summary cli/run.ts builds as
// each scenario finishes. A step's own record directory is derived from
// `record.evidence.dir` (`"<stateDir>/runs/<run_id>/scenarios/<scenarioId>"`,
// src/record/state-layout.ts): two levels up is the run's own directory,
// the one every step record of this run was written under
// (`<stateDir>/runs/<run_id>/steps/<recordId>`).
//
// A missing or unparseable record.json collapses to `null`
// (read-step-record.ts itself makes that call); this function only decides
// *which* step records to read, once each, keyed by id.

export function readStepRecordsForScenario(
  rootDir: string,
  record: ScenarioRecord,
): ReadonlyMap<string, StepRecord | null> {
  const stepsDir = path.join(rootDir, path.dirname(path.dirname(record.evidence.dir)), "steps");
  const records = new Map<string, StepRecord | null>();
  for (const step of record.steps) {
    if (step.step_record_id !== null && !records.has(step.step_record_id)) {
      records.set(step.step_record_id, readStepRecord(path.join(stepsDir, step.step_record_id)));
    }
  }
  return records;
}
