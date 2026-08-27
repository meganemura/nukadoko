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

export async function buildStepIndex(source: FileSource): Promise<ExtractionResult> {
  const filePaths = await source.listFiles();
  const patterns: ExtractionResult["patterns"][number][] = [];
  const unresolved: ExtractionResult["unresolved"][number][] = [];

  for (const filePath of filePaths) {
    const sourceText = await source.readFile(filePath);
    const result = await extractStepDeclarations(filePath, sourceText);
    patterns.push(...result.patterns);
    unresolved.push(...result.unresolved);
  }

  return { patterns, unresolved };
}
