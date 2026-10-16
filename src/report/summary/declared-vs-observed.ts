import type { StepRecord } from "../../record/types.js";

// Responsibility: the "Declared vs observed" section shared by the two
// Markdown documents a person reads about a run: the run summary `nuka run`
// writes (src/run/run-summary.ts) and the acceptance record `nuka accept`
// writes (src/accept/render-record.ts). Pure: callers hand in the step
// records they already read, and decide for themselves what a missing one
// means (accept refuses; a run summary skips a step that never ran).
//
// The section sets a step's declaration (`mutates`) against what was
// measured (`observed.http_writes`) and states only the raw fact, never a
// verdict. A step reading over POST lands here every time, by design: the
// HTTP method is not a trustworthy signal of a write, which is the same
// reason run-time `mutates` enforcement was dropped. So this section is a
// record, not an accusation.

/** One step that ran and has a step record to compare. */
export interface ComparedStep {
  readonly scenarioName: string;
  readonly stepText: string;
  readonly stepRecord: Pick<StepRecord, "mutates" | "observed">;
}

/** One step whose step record declared `mutates: false` but was measured
 * making at least one write. */
export interface DeclaredVsObservedMismatch {
  readonly scenarioName: string;
  readonly stepText: string;
  readonly writes: number;
}

export interface DeclaredVsObserved {
  readonly mismatches: readonly DeclaredVsObservedMismatch[];
  /** Compat steps carry `mutates: null`: nothing to compare, which is a
   * different fact from "compared and matched", so it is counted apart. */
  readonly compatStepCount: number;
}

export function collectDeclaredVsObserved(steps: Iterable<ComparedStep>): DeclaredVsObserved {
  const mismatches: DeclaredVsObservedMismatch[] = [];
  let compatStepCount = 0;
  for (const { scenarioName, stepText, stepRecord } of steps) {
    if (stepRecord.mutates === null) {
      compatStepCount += 1;
      continue;
    }
    if (stepRecord.mutates === false && stepRecord.observed.http_writes > 0) {
      mismatches.push({ scenarioName, stepText, writes: stepRecord.observed.http_writes });
    }
  }
  return { mismatches, compatStepCount };
}

/** One roll-up section rather than a note per scenario: a per-scenario note
 * is what a reader scrolling past scenario after scenario misses. Always
 * present, even with no mismatch, so "compared, found nothing" stays
 * distinguishable from "never compared". */
export function renderDeclaredVsObserved(result: DeclaredVsObserved): string[] {
  const { mismatches, compatStepCount } = result;
  const lines: string[] = ["", "## Declared vs observed", ""];

  if (mismatches.length === 0) {
    lines.push("No step declared `mutates: false` and was measured making a write.");
  } else {
    lines.push(
      "Steps that declared `mutates: false` and were measured making writes. This is a comparison, not a verdict: a step that reads over POST records writes by design.",
      "",
    );
    for (const mismatch of mismatches) {
      const writeWord = mismatch.writes === 1 ? "write" : "writes";
      lines.push(
        `- "${mismatch.stepText}" (scenario "${mismatch.scenarioName}"): declared mutates: false, observed ${mismatch.writes} ${writeWord}`,
      );
    }
  }

  if (compatStepCount > 0) {
    const stepWord = compatStepCount === 1 ? "step" : "steps";
    const verb = compatStepCount === 1 ? "has" : "have";
    lines.push("", `${compatStepCount} compat ${stepWord} ${verb} no \`mutates\` declaration to compare.`);
  }

  return lines;
}
