import type { PickleStep } from "@cucumber/messages";
import type { CheckedPattern } from "../check/binding-check.js";
import { matchPickleStepText } from "../check/feature-check.js";
import type { FeatureFile } from "../feature/load-features.js";

// Responsibility: the one pass over every feature's pickle steps that both
// "from nothing exercises" (from-unused.ts) and "pattern no feature binds"
// (pattern-unbound.ts) need — which step name, if any, each pickle step
// *uniquely* resolves to, and (for from-unused.ts) that occurrence's own
// matched capture set. Built once here and shared by both findings rather
// than each re-walking every feature, and built through
// src/check/feature-check.ts's own `matchPickleStepText`, the same capture
// judgment src/check/feature-check.ts/src/check/from-order.ts already use —
// never a third implementation of pattern matching.
//
// "Bound" here means the same thing src/check/from-order.ts's own
// `resolvedNames` means: exactly one pattern matched this line's text. A
// line matching zero or two-or-more patterns is not counted as an
// occurrence of *any* step name — undefined-step and ambiguous-step are
// src/check/feature-check.ts's own findings, and a line `nuka run` could
// never actually resolve to this step is not evidence that this step's
// `from`/pattern is healthy or unhealthy either way. Using the same
// tightened notion of "bound" for both findings here, rather than a looser
// "matched at all" for one and a stricter one for the other, keeps "what
// counts as bound" answering one question consistently across this module.

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

  for (const feature of features) {
    for (const pickle of feature.pickles) {
      for (const pickleStep of pickle.steps) {
        const { stepNames, matched } = matchPickleStepText(pickleStep.text, patterns);
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
