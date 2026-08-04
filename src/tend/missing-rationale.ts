import type { Vocabulary } from "../discover/discover-steps.js";
import type { TendIssue } from "./types.js";

// Responsibility: docs/spec.md "Tending"'s "A step with no `rationale`"
// finding. `description` (checked by src/tend/missing-describe.ts's sibling
// finding, at the field level) says what a step does — enough to call it.
// `rationale` says why it's built this way and what was rejected
// (docs/spec.md "Typed steps"); missing it, an agent has no material to
// judge whether it may rewrite the step. `Step.rationale` is `undefined`
// exactly when a step author omitted it (src/step/define-step.ts's own
// `defineStep`, no default) — checked directly, nothing to unwrap or infer.

export function findMissingRationale(vocabulary: Vocabulary): TendIssue[] {
  const issues: TendIssue[] = [];

  for (const entry of vocabulary.values()) {
    if (entry.kind !== "typed") {
      continue; // Compat has no `rationale` field at all.
    }
    if (entry.step.rationale !== undefined) {
      continue;
    }
    issues.push({
      code: "step-rationale-missing",
      message: `Step "${entry.name}" has no rationale: description says what it does, but nothing here says why it's built this way or what was rejected, which is what an agent needs before deciding it may rewrite it.`,
      step: entry.name,
    });
  }

  return issues;
}
