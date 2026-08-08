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
// looks at `vocabulary`'s typed entries.

export function findUnboundPatternedSteps(vocabulary: Vocabulary, occurrences: StepOccurrences): TendIssue[] {
  const issues: TendIssue[] = [];

  for (const entry of vocabulary.values()) {
    if (entry.kind !== "typed") {
      continue;
    }
    if (entry.step.patterns.length === 0) {
      continue; // CLI-only vocabulary — no pattern to occupy a scenario with.
    }
    const stepOccurrences = occurrences.get(entry.name);
    if (stepOccurrences !== undefined && stepOccurrences.length > 0) {
      continue;
    }
    issues.push({
      code: "pattern-unbound",
      message: `Step "${entry.name}" declares a pattern, but no feature line under featuresDir binds it. It has no place in any scenario right now.`,
      step: entry.name,
    });
  }

  return issues;
}
