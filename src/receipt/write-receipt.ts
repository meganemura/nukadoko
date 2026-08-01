import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Receipt } from "./types.js";

// Responsibility: the one place a receipt actually reaches disk. Kept
// separate from the executor (src/cli/do.ts) so a test can assert on
// receipt.json's exact bytes without re-running a whole `do` execution.

export async function writeReceipt(evidenceDir: string, receipt: Receipt): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}
