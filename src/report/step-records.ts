import path from "node:path";
import { readStepRecord } from "../record/read-step-record.js";
import type { StepRecord } from "../record/types.js";
import type { ScenarioRecord } from "../run/record-types.js";

// Responsibility: read every record.json a scenario record's own steps
// reference, once per record — pulled up from
// src/report/allure/emitter.ts's own `stepRecordsForRecord`
// (its original home) into src/report/ itself because
// src/report/messages/emitter.ts now needs the identical read for the
// identical reason (both emitters map the same scenario record.json/step
// record.json pair, just onto different output shapes).
//
// `AllureEmitterOptions`/`MessagesEmitterOptions` each carry no `stateDir`
// of their own — a step's own record directory is instead derived from
// `record.evidence.dir` (`"<stateDir>/records/scenarios/<scenarioId>"`,
// src/run/run-scenario.ts): two levels up is `<stateDir>/records`, the same
// directory every step record in this run was written under
// (`<stateDir>/records/steps/<recordId>`, run-scenario.ts). Deriving it
// from a value the record already carries — rather than growing either
// emitter's own pinned options shape — keeps both interfaces untouched.
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
