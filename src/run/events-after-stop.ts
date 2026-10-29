import type { Recount, Recounted } from "../context/events-file.js";
import { tallyInputsOfSlice } from "../context/events-read.js";
import { COUNT_COMPARES, describeRange, judgeCount, rangeOf, type CountCompare } from "../execution-events/count.js";
import type { RunAfterWorldStop, RunClaim, RunScenario, RunStep } from "../record/run-result.js";
import type { EventsReadRecord, EventsSlice } from "../record/types.js";

// Responsibility: a claim on a count of execution events, judged again
// once its world has stopped, over every line of the producer's trace the
// program wrote. A claim step reads the producer's events when its claims
// are judged, and waits only while they may still become whole
// (src/context/events-read.ts), so a line can still arrive after that: a
// gap no line closes was open, the deadline passed, or a writer was
// slower than the claim. The world's stop counts every line again, and a
// claim the whole count would have judged otherwise was judged on lines
// still on their way, so the run marks its cell `broke`
// (src/run/verdict-table.ts): the verdict stands on nothing either way.
// Pure. Boundary: counting the lines is the world's stop's
// (src/context/events-file.ts), judging a count is
// src/execution-events/count.ts's, and which claim reads which reading
// is the step contract's, which names the reading's key in the claim's
// measured channel: `events_read.<key>` of the claim step's own record.

/** The measured channel a claim on a reading names, before its key. */
const READING_CHANNEL = "events_read.";

/** Where one reading sits in the scenarios it was found in. */
export interface ReadingPlace {
  /** The scenario's index in the scenarios given. */
  readonly scenario: number;
  /** The claim step's index in the scenario. */
  readonly step: number;
  readonly key: string;
}

/** The readings of `scenarios`, the entries of one world's pass, whose
 * producer is a step of the same pass: what its stop counts again, each
 * with its place. A reading of a finished record (`nuka do --use`) has
 * its producer in another world, and a reading of nothing has none. */
export function readingsToRecount(scenarios: readonly RunScenario[]): { readonly places: readonly ReadingPlace[]; readonly recounts: readonly Recount[] } {
  const producers = new Map<string, EventsSlice>();
  for (const scenario of scenarios) {
    for (const step of scenario.steps) {
      const events = step.observed?.events;
      if (events !== undefined && events !== null) producers.set(events.trace_id, events);
    }
  }
  const places: ReadingPlace[] = [];
  const recounts: Recount[] = [];
  scenarios.forEach((scenario, scenarioIndex) =>
    scenario.steps.forEach((step, stepIndex) => {
      for (const [key, read] of Object.entries(step.events_read ?? {})) {
        const slice = read.trace_id === null ? undefined : producers.get(read.trace_id);
        if (slice === undefined) continue;
        places.push({ scenario: scenarioIndex, step: stepIndex, key });
        recounts.push({
          traceId: slice.trace_id,
          inputs: tallyInputsOfSlice(slice),
          selection: read.count,
          replaced: read.open.some((gap) => gap.gap === "file-replaced"),
        });
      }
    }),
  );
  return { places, recounts };
}

function lines(count: number): string {
  return count === 1 ? "1 line" : `${count} lines`;
}

function isCountCompare(compare: string): compare is CountCompare {
  return (COUNT_COMPARES as readonly string[]).includes(compare);
}

/** `claim`, judged on `read`, judged again on `recounted`, the same
 * selection counted over every line of the producer's trace: `undefined`
 * when the claim is not one on a count, judged nothing, or no line of the
 * trace arrived after it was judged. Pure. */
export function afterWorldStop(claim: RunClaim, read: EventsReadRecord, recounted: Recounted): RunAfterWorldStop | undefined {
  if ("each" in claim || claim.outcome === "unobserved") return undefined;
  if (!isCountCompare(claim.compare) || typeof claim.expected !== "number") return undefined;
  const judged = read.lines + read.unreadable;
  const all = recounted.lines + recounted.unreadable;
  if (all <= judged) return undefined;
  // The reading's window closed when it read: the lines no step owns in it
  // may still be the producer's, and the stop counts none of them.
  const maybe = { ...recounted.count.maybe, unowned: recounted.count.maybe.unowned + read.maybe.unowned };
  const whole = recounted.open.length === 0;
  const range = rangeOf({ yes: recounted.count.yes, maybe }, whole);
  const judgment = judgeCount({ range, whole, open: recounted.open, maybe }, claim.compare, claim.expected);
  const late = `${lines(all - judged)} of the trace of step "${read.of?.step ?? "unknown"}" arrived after this claim judged ${judged}`;
  const reason =
    judgment.outcome === "unjudged"
      ? `${late}; ${judgment.reason}`
      : `${late}; over all ${all}, the count is ${describeRange(range)}, so the claim ${judgment.outcome === "held" ? "holds" : "breaks"}`;
  return { lines: recounted.lines, range, outcome: judgment.outcome, reason };
}

/** The key of the reading `claim` of `step` is measured on, if any. */
function readingKeyOf(claim: RunClaim, step: RunStep): string | undefined {
  const { measured } = claim;
  if (measured === null || measured.step_record_id !== step.step_record_id || !measured.channel.startsWith(READING_CHANNEL)) return undefined;
  return measured.channel.slice(READING_CHANNEL.length);
}

/** `scenario` with `after_world_stop` on each claim measured on a reading
 * `recountedAt` has the whole count of, by the claim step's index and the
 * reading's key. The same entry when no claim changed. Pure. */
export function withAfterWorldStop(scenario: RunScenario, recountedAt: (step: number, key: string) => Recounted | undefined): RunScenario {
  let changed = false;
  const steps = scenario.steps.map((step, index) => {
    const readings = step.events_read;
    if (step.claims === undefined || readings === undefined) return step;
    let stepChanged = false;
    const claims = step.claims.map((claim) => {
      const key = readingKeyOf(claim, step);
      const read = key === undefined ? undefined : readings[key];
      const recounted = key === undefined ? undefined : recountedAt(index, key);
      if (read === undefined || recounted === undefined) return claim;
      const after = afterWorldStop(claim, read, recounted);
      if (after === undefined) return claim;
      stepChanged = true;
      return { ...claim, after_world_stop: after };
    });
    if (!stepChanged) return step;
    changed = true;
    return { ...step, claims };
  });
  return changed ? { ...scenario, steps } : scenario;
}

/** The index of the first step with a claim the world's stop judged
 * otherwise than the claim itself was judged, or -1: that execution was
 * judged on lines still on their way. Pure. */
export function stepJudgedTooEarly(steps: readonly RunStep[]): number {
  return steps.findIndex((step) => (step.claims ?? []).some((claim) => claim.after_world_stop !== undefined && claim.after_world_stop.outcome !== claim.outcome));
}
