// Responsibility: the one finding shape `nuka tend`'s five (soon six, once
// m8b adds the sign-off finding) checks all produce. Shaped identically to
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
// `errors` was `[]` throughout m8a (that task's own non-scope: sign-off
// staleness — the one finding docs/spec.md "Tending" marks as an error — was
// left for m8b, which parses accepted-record Markdown m8a never touched).
// The field existed from m8a onward rather than being added later, so m8b's
// report shape (src/tend/signoff-rot.ts populating it) is additive rather
// than a breaking change to `--json` consumers who already saw an
// always-empty `errors` array.

export interface TendIssue {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly step?: string;
}

export interface TendReport {
  readonly errors: readonly TendIssue[];
  readonly notes: readonly TendIssue[];
}
