import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScenarioRecord } from "./record-types.js";

// Responsibility: the one place a scenario record actually reaches disk —
// the scenario-level counterpart to receipt/write-receipt.ts, kept separate
// from run-scenario.ts for the same reason: a test can assert on
// record.json's exact bytes without re-running a whole scenario.

export async function writeScenarioRecord(
  scenarioDir: string,
  record: ScenarioRecord,
): Promise<void> {
  await mkdir(scenarioDir, { recursive: true });
  await writeFile(path.join(scenarioDir, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
}
