// Responsibility: the one finding shape `nuka tend`'s six checks all
// produce. Shaped identically to
// src/check/types.ts's `CheckIssue` (code/message/optional file/line/step)
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
// `errors` started out always `[]`: sign-off
// staleness — the one finding docs/spec.md "Tending" marks as an error — was
// added later, once accepted-record Markdown parsing existed to support it.
// The field existed from the start rather than being added later, so
// src/tend/signoff-rot.ts populating it is additive rather
// than a breaking change to `--json` consumers who already saw an
// always-empty `errors` array.

export interface TendIssue {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly step?: string;
}

/** How much of a countable thing typed steps declare vs. could declare —
 * shared shape for the two "declaration coverage" numbers below: exactly
 * two such numbers, `rationale` and `describe`,
 * kept to that shape rather than each spelling out its own field names so a
 * reader sees at a glance that both mean "declared out of total". */
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
 * typed vs. compat, and the two declaration-coverage ratios — on purpose:
 * every additional number here dilutes the ones that matter.
 *
 * `compatStepNames` names every counted entity for `--json`'s reader: an
 * agent finds "these 8" more actionable than "compat is 8".
 * `rationale`/`describe` do *not* get an equivalent name list —
 * `missing-rationale.ts`/`missing-describe.ts`'s own notes already name
 * those steps/fields individually (with a `file`), so repeating the names
 * here would be the same information twice; only the migration breakdown is
 * new, because nothing else in this report currently names a compat step at
 * all.
 *
 * `scannedFeatureDirs` and `readOnlySteps` are the two exceptions to the
 * "cap at three numbers"
 * rule just above, added deliberately rather than by drift: `pattern-unbound`
 * had gone quietly wrong for any project that placed an accepted feature
 * outside `featuresDir` (docs/spec.md's own recommendation), because nothing
 * in `tend`'s own output said which directories it had actually looked at —
 * `scannedFeatureDirs` is what makes that fixable by reading the output
 * rather than the source. `readOnlySteps` is counted in the same loop as
 * the typed/compat counts (src/tend/summary.ts's own counting loop,
 * `entry.step.mutates === false`), belonging beside them rather than a
 * separate pass. */
export interface TendSummary {
  readonly typedSteps: number;
  readonly compatSteps: number;
  readonly compatStepNames: readonly string[];
  readonly rationale: TendDeclarationCoverage;
  readonly describe: TendDeclarationCoverage;
  readonly scannedFeatureDirs: readonly string[];
  readonly readOnlySteps: number;
}

export interface TendReport {
  readonly errors: readonly TendIssue[];
  readonly notes: readonly TendIssue[];
  readonly summary: TendSummary;
}

/** Every code a `nuka tend` finding can carry. `nuka tend --fail-on <code>`
 * refuses a code outside this set, so a typo cannot become a flag that
 * never fires; tests/tend-fail-on.test.ts keeps this list equal to the
 * literals under src/tend/. */
export const TEND_CODES: ReadonlySet<string> = new Set([
  "additional-feature-dir-missing",
  "feature-never-signed",
  "fixture-touches-app",
  "fixture-unused",
  "from-unused",
  "import-failures-unseen",
  "parameter-type-support-origin",
  "parameter-type-unused",
  "pattern-unbound",
  "post-navigation-read",
  "repeated-scenario-prefix",
  "schema-field-undescribed",
  "secrets-public-key-unknown",
  "secrets-redact-key-unknown",
  "signed-feature-unscanned",
  "signoff-condition-mismatch",
  "signoff-feature-changed",
  "signoff-feature-missing",
  "signoff-record-old-format",
  "signoff-record-unreadable",
  "signoff-result-invalid",
  "signoff-step-missing",
  "step-rationale-missing",
]);
