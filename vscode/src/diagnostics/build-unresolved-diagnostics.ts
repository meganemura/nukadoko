// Responsibility: turn extractStepDeclarations's own "found a declaration
// but could not read its pattern" list into the same DiagnosticsEntry shape
// build-diagnostics.ts produces from `nuka check --json`, so the glue layer
// (extension.ts's applyDiagnostics/groupDiagnosticsByFile/toDiagnostic)
// shows both through one, already-proven path rather than a second one.
// Never imports "vscode" -- same split as the rest of src/diagnostics, kept
// runnable under vitest.
import type { UnresolvedDeclaration } from "../extraction/index.js";
import type { DiagnosticsEntry } from "./build-diagnostics.js";

// Stable across releases: a user or a future check could match on this
// string, so it never changes shape just because the message wording does.
const UNRESOLVED_CODE = "nukadoko-static-unresolved";

/**
 * One `DiagnosticsEntry` per `UnresolvedDeclaration`, never filtered or
 * merged: each declaration this extension found but could not read a
 * pattern from is its own line a user can act on.
 */
export function buildUnresolvedDiagnostics(
  unresolved: readonly UnresolvedDeclaration[],
): readonly DiagnosticsEntry[] {
  return unresolved.map((declaration) => ({
    file: declaration.declarationFile,
    // declarationPosition.row is 0-indexed (tree-sitter's own convention);
    // DiagnosticsEntry.line matches CheckIssue.line's 1-indexed convention,
    // which toDiagnostic (extension.ts) already converts back with `- 1`.
    line: declaration.declarationPosition.row + 1,
    message: `This step declaration is statically unresolvable: ${declaration.reason}`,
    severity: "warning",
    code: UNRESOLVED_CODE,
  }));
}
