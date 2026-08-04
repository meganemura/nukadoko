import type { Vocabulary } from "../discover/discover-steps.js";
import type { TendSummary } from "./types.js";

// Responsibility: docs/spec.md "Tending"'s "Before any finding, `tend`
// states where the bed currently is" paragraphs — a summary, not a finding
// (m8c-tend-summary task spec: never touches `errors`/`notes`, never affects
// the exit code, since a suite mid-migration with compat steps still on disk
// is a normal state, not rot).
//
// Every input here is already computed exactly once by src/tend/analyze.ts
// for the findings themselves: `rationaleMissingCount` is
// `findMissingRationale(vocabulary).length` (that finding is already one
// issue per rationale-less typed step, so its own issue count *is* the
// missing count — no second pass needed), and `fieldDescriptions` is
// src/tend/missing-describe.ts's `analyzeFieldDescriptions` result, which
// already walked every field once to build its own issues. This function
// only counts typed vs. compat vocabulary entries, which no other finding
// here counts at all — the one number this task's spec calls genuinely new
// ("名指しが新しい情報になるのは移行の内訳だけ").
export function buildTendSummary(
  vocabulary: Vocabulary,
  rationaleMissingCount: number,
  fieldDescriptions: { readonly totalFields: number; readonly describedFields: number },
): TendSummary {
  let typedSteps = 0;
  const compatStepNames: string[] = [];

  for (const entry of vocabulary.values()) {
    if (entry.kind === "typed") {
      typedSteps += 1;
    } else {
      compatStepNames.push(entry.name);
    }
  }

  return {
    typedSteps,
    compatSteps: compatStepNames.length,
    compatStepNames,
    rationale: { declared: typedSteps - rationaleMissingCount, total: typedSteps },
    describe: { declared: fieldDescriptions.describedFields, total: fieldDescriptions.totalFields },
  };
}
