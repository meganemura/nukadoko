// Responsibility: the one rule both report emitters use to place a
// scenario's steps in time. Pure: no I/O, no report format.
//
// A step with a step record keeps that record's own started_at/finished_at.
// A step with no step record (skipped, undefined, ambiguous, or a refusal
// before it began) has no time of its own, so it is zero-width at the
// previous step's stop, or at the scenario's own start when it comes first.
// That anchor is read from record.json alone. The other candidate, the wall
// clock at the moment the runner appended the step, is never persisted, so a
// report built from record.json after the run could not reproduce it, and the
// Allure and cucumber-messages reports of one record would disagree.

export interface StepSpan {
  readonly startMs: number;
  readonly stopMs: number;
}

/** A step record's own span, or `null` for a step without one. */
export function ownStepSpan(stepRecord: { readonly started_at: string; readonly finished_at: string } | null | undefined): StepSpan | null {
  if (!stepRecord) {
    return null;
  }
  return { startMs: Date.parse(stepRecord.started_at), stopMs: Date.parse(stepRecord.finished_at) };
}

/** One span per step, in step order. */
export function placeSteps(scenarioStartMs: number, ownSpans: readonly (StepSpan | null)[]): StepSpan[] {
  let previousStopMs = scenarioStartMs;
  return ownSpans.map((own) => {
    const span = own ?? { startMs: previousStopMs, stopMs: previousStopMs };
    previousStopMs = span.stopMs;
    return span;
  });
}
