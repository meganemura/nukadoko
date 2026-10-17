import { listTendCodes } from "./codes.js";

// Responsibility: which of `analyzeTend`'s notes `nuka tend` reports by
// default. Analysis still computes every finding (the `declared:` summary
// line counts the declaration code either way); this module only decides
// what is printed and what `--fail-on` can see.
//
// The declaration code is opt-in because it names nothing that rots. A
// missing `.describe()` is a gap a project may choose to fill, not a
// declaration that has drifted away from what it describes. Reported on
// every run, it outnumbered every other finding in a fresh project. `--all`
// brings it back, and so does naming it in `--fail-on`: a team that gates
// on a code has asked for it, and a gate that could never see its own code
// would pass silently.

/** Codes `nuka tend` reports only under `--all`, or when `--fail-on` names
 * them. */
export const DECLARATION_TEND_CODES: ReadonlySet<string> = new Set(
  listTendCodes()
    .filter((entry) => !entry.reportedByDefault)
    .map((entry) => entry.code),
);

export interface NoteSelection {
  readonly all: boolean;
  readonly failOn: readonly string[];
}

/** The notes to report, in their original order. */
export function selectReportedNotes<T extends { readonly code: string }>(
  notes: readonly T[],
  selection: NoteSelection,
): T[] {
  if (selection.all) return [...notes];
  const requested = new Set(selection.failOn);
  return notes.filter((note) => !DECLARATION_TEND_CODES.has(note.code) || requested.has(note.code));
}
