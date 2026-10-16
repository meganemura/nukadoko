import { findUnboundPatternedEntries, rootRelativeStepFile } from "../check/unbound-patterned.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import type { TendIssue } from "./types.js";
import type { StepOccurrences } from "./step-bindings.js";

// Responsibility: docs/spec.md "Tending"'s "A step with a pattern that no
// feature binds" finding — a typed step declares a pattern (it means to
// occupy a place in a scenario) but no feature line resolves uniquely to it
// (src/tend/step-bindings.ts's own "bound" — see that file's header for why
// ambiguous/undefined lines don't count either way here). Compat steps are
// out of scope entirely: an unused compat glue file mid-migration is the
// expected, healthy state (docs/spec.md "Compat steps"), so this only ever
// looks at `vocabulary`'s typed entries. Which steps are unbound comes from
// src/check/unbound-patterned.ts, the list `nuka check`'s `undefined-step`
// suffix reads too, so both commands name the same steps on the same files.
// `file` is root-relative: it is the file a reader opens next.

export function findUnboundPatternedSteps(
  vocabulary: Vocabulary,
  occurrences: StepOccurrences,
  rootDir: string,
): TendIssue[] {
  const bound = new Set([...occurrences].filter(([, list]) => list.length > 0).map(([name]) => name));
  return findUnboundPatternedEntries(vocabulary, bound).map((entry) => ({
    code: "pattern-unbound",
    message: `Step "${entry.name}" declares a pattern, but no feature line under the scanned directories binds it. It has no place in any scenario right now.`,
    file: rootRelativeStepFile(rootDir, entry),
    step: entry.name,
  }));
}
