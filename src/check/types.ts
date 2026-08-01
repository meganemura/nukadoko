// Responsibility: the one issue shape every check category (binding-check,
// feature-check, config-check) produces, so `nuka check` can treat pattern/
// schema mismatches, undefined steps, config coherence, etc. uniformly for
// both the human-readable and `--json` outputs (docs/spec.md "CLI summary").
// `code` is the stable, kebab-case identifier a script can match on;
// `message` is prose for a human; `file`/`line`/`step` are position info,
// present only when the issue that produced them actually has one.

export interface CheckIssue {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly step?: string;
}

export interface CheckReport {
  readonly errors: readonly CheckIssue[];
  readonly warnings: readonly CheckIssue[];
}
