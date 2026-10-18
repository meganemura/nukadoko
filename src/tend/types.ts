import { listTendCodes, type TendCode } from "./codes.js";

// Responsibility: the one finding shape `nuka tend`'s six checks all
// produce. Shaped identically to
// src/check/types.ts's `CheckIssue` (code/message/optional file/line/step, plus `fixture`)
// but declared fresh rather than imported: `check` answers "can this run"
// and `tend` answers "is this healthy" (docs/spec.md "Tending" — deliberately
// two commands, read at different moments, so a real slowdown-worthy line on
// `check` is never buried among things nobody has to fix today). Importing
// `check`'s own type here would wire that separation's *data* back together
// even though its *meaning* stays split — the report wrapper already can't
// be shared either (`{ errors, notes }` here, not check's `{ errors,
// warnings }`: "note" is tending's own word for a finding nobody has to act
// on, docs/spec.md's own "the rest do not, because a project is allowed to
// carry them").
//
// `errors` is always empty today: every finding is a note (src/tend/
// analyze.ts's own header says why the field stays).

export interface TendIssue {
  readonly code: TendCode;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly step?: string;
  /** Set instead of `step` on a finding about a `config.fixtures` entry, so a
   * fixture and a step of the same name stay distinguishable in `--json`. */
  readonly fixture?: string;
  /** Set where the finding is raised only when that place knows a more
   * exact edit than the code's registry entry. */
  readonly fix?: string;
}

/** A finding as the report carries it: `fix` always present, and `file`
 * filled from the step's own file, or the config file for a finding about
 * config, when the finding was raised without one. */
export interface TendFinding extends TendIssue {
  readonly fix: string;
}

/** How much of a countable thing typed steps declare vs. could declare. */
export interface TendDeclarationCoverage {
  readonly declared: number;
  readonly total: number;
}

/** Where the vocabulary currently is, stated once before any finding
 * (docs/spec.md "Tending": "Before any finding, `tend` states where the bed
 * currently is") — not itself a finding: a suite mid-migration with compat
 * steps still on disk is a normal state, so this never touches `errors`/
 * `notes` or the exit code.
 * Capped at the three numbers docs/spec.md's own two paragraphs name —
 * typed vs. compat, and the declaration-coverage ratio — on purpose:
 * every additional number here dilutes the ones that matter.
 *
 * `compat_step_names` names every counted entity for `--json`'s reader: an
 * agent finds "these 8" more actionable than "compat is 8".
 * `describe` does *not* get an equivalent name list —
 * `missing-describe.ts`'s own notes already name
 * those fields individually (with a `file`), so repeating the names
 * here would be the same information twice; only the migration breakdown is
 * new, because nothing else in this report currently names a compat step at
 * all.
 *
 * `scanned_feature_dirs` and `read_only_steps` are the two exceptions to the
 * "cap at three numbers"
 * rule just above, added deliberately rather than by drift: `pattern-unbound`
 * had gone quietly wrong for any project that placed a feature outside
 * `featuresDir`, because nothing
 * in `tend`'s own output said which directories it had actually looked at —
 * `scanned_feature_dirs` is what makes that fixable by reading the output
 * rather than the source. `read_only_steps` is counted in the same loop as
 * the typed/compat counts (src/tend/summary.ts's own counting loop,
 * `entry.step.mutates === false`), belonging beside them rather than a
 * separate pass. */
export interface TendSummary {
  readonly typed_steps: number;
  readonly compat_steps: number;
  readonly compat_step_names: readonly string[];
  readonly describe: TendDeclarationCoverage;
  readonly scanned_feature_dirs: readonly string[];
  readonly read_only_steps: number;
}

export interface TendReport {
  readonly errors: readonly TendFinding[];
  readonly notes: readonly TendFinding[];
  readonly summary: TendSummary;
}

// The placeholder scaffold writes is the one the note matches, so both
// read it from here.
export { DESCRIPTION_TODO_PREFIX } from "./description-todo.js";

export { listTendCodes, tendCodeFix, type TendCode, type TendCodeEntry, type TendCodeInfo } from "./codes.js";

/** Every code a `nuka tend` finding can carry. `nuka tend --fail-on <code>`
 * refuses a code outside this set, so a typo cannot become a flag that
 * never fires; tests/tend-fail-on.test.ts keeps this list equal to the
 * literals under src/tend/. */
export const TEND_CODES: ReadonlySet<string> = new Set(listTendCodes().map((entry) => entry.code));

/** Codes an earlier release reported and this one does not, each with what
 * replaced it. `nuka tend --fail-on` refuses these like any unknown code, but
 * names the replacement: a CI job written against the old code would
 * otherwise only learn that the code is gone, not what to gate on now. The
 * nine sign-off codes went away with `nuka accept`; the run summary that
 * `nuka run` writes, carried on the pull request, is what a person reads
 * instead. The two codes that repeated a `nuka check` finding now live only
 * there, so `nuka check`'s exit code is the gate. */
export const REMOVED_TEND_CODES: ReadonlyMap<string, string> = new Map([
  [
    "step-rationale-missing",
    "was removed with defineStep's `rationale` option. Delete the `rationale:` lines from your step files; `nuka check` names each one as step-option-ignored (docs/upgrading.md)",
  ],
  [
    "additional-feature-dir-missing",
    "is reported only by `nuka check` now, as an error, so a failing `nuka check` is the gate (docs/upgrading.md)",
  ],
  [
    "import-failures-unseen",
    "is reported only by `nuka check` now, as `step-file-import-failed`, so a failing `nuka check` is the gate (docs/upgrading.md)",
  ],
  ...[
    "feature-never-signed",
    "signed-feature-unscanned",
    "signoff-condition-mismatch",
    "signoff-feature-changed",
    "signoff-feature-missing",
    "signoff-record-old-format",
    "signoff-record-unreadable",
    "signoff-result-invalid",
    "signoff-step-missing",
  ].map((code) => [
    code,
    "was removed with `nuka accept`. A person now reads the run summary `nuka run` writes, on the pull request, and approving the pull request is the sign-off (docs/upgrading.md)",
  ] as const),
]);
