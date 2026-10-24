import { findUnboundPatternedEntries, rootRelativeStepFile } from "./unbound-patterned.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import type { CheckIssue } from "./types.js";
import type { StepOccurrences } from "./step-bindings.js";

// Responsibility: the `pattern-unbound` note. A typed step declares a
// pattern (it means to occupy a place in a scenario) but no feature line
// resolves uniquely to it (src/check/step-bindings.ts's "bound": its header
// says why ambiguous and undefined lines count neither way). Boundary:
// compat steps are out of scope. An unused compat glue file mid-migration is
// the expected, healthy state (docs/spec.md "Compat steps"), so this reads
// only `vocabulary`'s typed entries. Which steps are unbound comes from
// src/check/unbound-patterned.ts, the list the `undefined-step` suffix reads
// too, so both findings name the same steps on the same files.
//
// The message names the directories that were scanned because "no feature
// binds it" is only true of the feature files nukadoko read: a step bound
// from a directory missing from `additionalFeatureDirs` looks unbound, and
// the directory list is what lets a reader see that. `file` is root-relative:
// it is the file a reader opens next.

export function findUnboundPatternedSteps(
  vocabulary: Vocabulary,
  occurrences: StepOccurrences,
  rootDir: string,
  scannedDirs: readonly string[],
): CheckIssue[] {
  const bound = new Set([...occurrences].filter(([, list]) => list.length > 0).map(([name]) => name));
  const where = scannedDirs.join(", ");
  return findUnboundPatternedEntries(vocabulary, bound).map((entry) => ({
    code: "pattern-unbound",
    message: `Step "${entry.name}" declares a pattern, but no feature line under the scanned directories (${where}) binds it. It has no place in any scenario right now.`,
    file: rootRelativeStepFile(rootDir, entry),
    step: entry.name,
  }));
}
