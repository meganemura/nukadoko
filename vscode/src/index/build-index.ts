// Responsibility: assemble one ExtractionResult across every step file a
// workspace has. How "the workspace" is enumerated and read is not this
// module's concern -- FileSource is injected by the caller, so this file
// never imports `vscode` and stays runnable under vitest, which cannot
// resolve that module at all (only the real extension host can). The real
// FileSource (vscode.workspace.findFiles + workspace.fs.readFile) lives in
// src/extension.ts; tests inject an in-memory fake instead.
import { extractStepDeclarations, type ExtractionResult } from "../extraction/index.js";

export interface FileSource {
  /** Absolute paths of every file this index should consider. */
  listFiles(): Promise<readonly string[]>;
  readFile(filePath: string): Promise<string>;
}

export interface UnreadableFile {
  readonly file: string;
  readonly reason: string;
}

/** A file that cannot be read or parsed is recorded in `unreadable` and the
 * rest are still indexed: one locked or vanished file must not cost every
 * definition and completion in the workspace. */
export interface StepIndex extends ExtractionResult {
  readonly unreadable: readonly UnreadableFile[];
}

export async function buildStepIndex(source: FileSource): Promise<StepIndex> {
  const filePaths = await source.listFiles();
  const patterns: ExtractionResult["patterns"][number][] = [];
  const unresolved: ExtractionResult["unresolved"][number][] = [];
  const unreadable: UnreadableFile[] = [];

  for (const filePath of filePaths) {
    let result: ExtractionResult;
    try {
      result = await extractStepDeclarations(filePath, await source.readFile(filePath));
    } catch (error) {
      unreadable.push({ file: filePath, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    patterns.push(...result.patterns);
    unresolved.push(...result.unresolved);
  }

  return { patterns, unresolved, unreadable };
}
