import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StepRecord } from "./types.js";

// Responsibility: the one place a step record actually reaches disk. Kept
// separate from the executor (src/cli/do.ts) so a test can assert on
// record.json's exact bytes without re-running a whole `do` execution.

export async function writeStepRecord(evidenceDir: string, record: StepRecord): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
}
