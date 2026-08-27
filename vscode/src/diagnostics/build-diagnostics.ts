// Responsibility: turn `nuka check --json`'s own report shape into a flat
// list a glue layer can turn into vscode.Diagnostic objects, without
// importing "vscode" -- same split as src/index and src/extraction, kept
// runnable under vitest. `CheckIssue`/`CheckReport` are redeclared here
// (matching src/check/types.ts in this repository's own root package)
// rather than imported: that module has no entry in the root package's
// package.json "exports" map, so importing it from here would reach past
// the published surface for a shape this file only needs to read as JSON.

interface CheckIssue {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly step?: string;
}

interface CheckReport {
  readonly errors: readonly CheckIssue[];
  readonly warnings: readonly CheckIssue[];
}

export interface DiagnosticsEntry {
  /** Empty when the source `CheckIssue` had no `file` (an issue about the
   * whole workspace, not one line of it) -- never dropped, so the glue
   * layer still has something to show for it (this module's own boundary:
   * *how* a file-less issue gets displayed is the glue layer's call, not
   * this one's). */
  readonly file: string;
  /** 1-indexed, straight from `CheckIssue.line` -- never present unless the
   * source issue named one. */
  readonly line?: number;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly code: string;
}

function toEntry(issue: CheckIssue, severity: "error" | "warning"): DiagnosticsEntry {
  return {
    file: issue.file ?? "",
    line: issue.line,
    message: issue.message,
    severity,
    code: issue.code,
  };
}

/**
 * Flattens a `nuka check --json` report's `errors`/`warnings` into one list,
 * each entry tagged with the severity its own array already meant. Never
 * filters an issue out for lacking a `file`: a check that silently dropped
 * the one kind of issue it can't point at a line would defeat the purpose
 * of running it at all.
 */
export function buildDiagnosticsFromCheckReport(checkReportJson: string): readonly DiagnosticsEntry[] {
  const report = JSON.parse(checkReportJson) as CheckReport;
  const entries: DiagnosticsEntry[] = [];
  for (const issue of report.errors) {
    entries.push(toEntry(issue, "error"));
  }
  for (const issue of report.warnings) {
    entries.push(toEntry(issue, "warning"));
  }
  return entries;
}
