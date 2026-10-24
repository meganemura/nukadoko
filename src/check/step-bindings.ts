import type { PickleStep } from "@cucumber/messages";
import type { CheckedPattern } from "./binding-check.js";
import { createStepTextMatcher } from "./feature-check.js";
import type { FeatureFile } from "../feature/load-features.js";

// Responsibility: the one pass over every feature's pickle steps that both
// the `from-unused` note (from-unused.ts) and the `pattern-unbound` note
// (pattern-unbound.ts) need: which step name, if any, each pickle step
// *uniquely* resolves to, and that occurrence's matched capture set. Built
// once here and shared by both notes rather than each re-walking every
// feature. Boundary: matching goes through src/check/feature-check.ts's
// `createStepTextMatcher`, the same capture judgment feature-check.ts and
// src/check/from-order.ts use, never a third implementation of pattern
// matching.
//
// "Bound" here means the same thing src/check/from-order.ts's own
// `resolvedNames` means: exactly one pattern matched this line's text. A
// line matching zero or two-or-more patterns is not counted as an
// occurrence of *any* step name: undefined-step and ambiguous-step are
// src/check/feature-check.ts's findings, and a line `nuka run` could never
// resolve to this step is not evidence that this step's `from` or pattern is
// healthy or unhealthy either way. One notion of "bound" for both notes,
// rather than a looser "matched at all" for one, keeps them answering one
// question.

export interface StepOccurrence {
  readonly pickleStep: PickleStep;
  readonly matched: CheckedPattern;
}

export type StepOccurrences = ReadonlyMap<string, readonly StepOccurrence[]>;

export function resolveStepOccurrences(
  features: readonly FeatureFile[],
  patterns: readonly CheckedPattern[],
): StepOccurrences {
  const occurrences = new Map<string, StepOccurrence[]>();
  const match = createStepTextMatcher(patterns);

  for (const feature of features) {
    for (const pickle of feature.pickles) {
      for (const pickleStep of pickle.steps) {
        const { stepNames, matched } = match(pickleStep.text);
        if (stepNames.length !== 1 || matched === undefined) {
          continue; // Undefined or ambiguous here — not this module's concern.
        }
        const stepName = stepNames[0]!;
        const list = occurrences.get(stepName);
        if (list) {
          list.push({ pickleStep, matched });
        } else {
          occurrences.set(stepName, [{ pickleStep, matched }]);
        }
      }
    }
  }

  return occurrences;
}
