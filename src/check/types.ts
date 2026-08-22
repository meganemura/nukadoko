// Responsibility: the one issue shape every check category (binding-check,
// feature-check, config-check) produces, so `nuka check` can treat pattern/
// schema mismatches, undefined steps, config coherence, etc. uniformly for
// both the human-readable and `--json` outputs (docs/spec.md "CLI summary").
// `code` is the stable, kebab-case identifier a script can match on, typed
// as `CheckCode` (src/check/codes.ts) rather than a bare `string`: a code
// literal written anywhere that is not registered there fails to compile at
// the point it reaches this shape, which is what keeps `nuka check --codes`
// (src/cli/check.ts) from ever falling out of sync with what this module
// can actually emit. `message` is prose for a human; `file`/`line`/`step`
// are position info, present only when the issue that produced them
// actually has one.

import type { CheckCode } from "./codes.js";

export interface CheckIssue {
  readonly code: CheckCode;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly step?: string;
}

export interface CheckReport {
  readonly errors: readonly CheckIssue[];
  readonly warnings: readonly CheckIssue[];
}
