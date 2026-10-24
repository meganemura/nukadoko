// Responsibility: the one issue shape every check category (binding-check,
// feature-check, config-check, and the notes) produces, so `nuka check` can treat pattern/
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
  /** Set instead of `step` on a finding about a `config.fixtures` entry, so a
   * fixture and a step of the same name stay distinguishable in `--json`. */
  readonly fixture?: string;
  /** Set where the finding is raised only when that place knows a more
   * exact edit than the code's registry entry, such as the file to change. */
  readonly fix?: string;
  /** Set only where one command, as written, gets past the finding. A
   * hint that would need a value nukadoko cannot fill is a `fix`. */
  readonly do?: string;
}

/** A finding as the report carries it: the raised `fix` and `do`, or the
 * code's general `fix` when the raiser named neither. `file` is filled from
 * the step's own file for a finding raised with only `step`. */
export type CheckFinding = CheckIssue;

export interface CheckReport {
  readonly errors: readonly CheckFinding[];
  readonly warnings: readonly CheckFinding[];
  /** Empty unless the report covers the whole project: src/check/analyze.ts
   * says why. */
  readonly notes: readonly CheckFinding[];
}
