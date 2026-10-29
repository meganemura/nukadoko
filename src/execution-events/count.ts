import { MAYBE_CAUSES, type EventsGap, type GapWord, type MaybeCounts, type SelectionCount } from "./tally.js";

// Responsibility: what a count of execution events says of a claim: the
// range the count lies in, and whether a compare holds, breaks, or cannot
// be known on that range, with the words of the reason. Pure. Boundary:
// what the lines add up to is tally.ts's; where the expected value comes
// from, and the record of a claim, are the step contract's.
//
// A count is a range, never one number standing for "probably that many".
// Lines that match raise the lower bound. Lines that may match raise only
// the upper bound, and a reading that is not whole has none, since more
// lines may still come. A compare holds, or breaks, only when it gives that
// answer for every count in the range; otherwise the claim is unjudged,
// and the reason names the first gap or the lines that may match. So an
// absence ("nothing was written") never holds on a reading that was not
// whole, and "at least one job was enqueued" can still hold on one.

/** A count, as far as the lines say: `at_most` is `null` when nothing
 * bounds it. */
export interface CountRange {
  readonly at_least: number;
  readonly at_most: number | null;
}

/** The range a selection's count lies in: `[yes, yes + maybe]` on a
 * whole reading, `[yes, unbounded]` on one that is not. */
export function rangeOf(count: SelectionCount, whole: boolean): CountRange {
  return { at_least: count.yes, at_most: whole ? count.yes + maybeTotal(count.maybe) : null };
}

/** How many lines may match, of every cause. */
export function maybeTotal(maybe: MaybeCounts): number {
  return MAYBE_CAUSES.reduce((total, cause) => total + maybe[cause], 0);
}

/** The compares a count claim may name. */
export const COUNT_COMPARES = ["equal", "not-equal", "greater-than", "at-least", "less-than", "at-most"] as const;

export type CountCompare = (typeof COUNT_COMPARES)[number];

/** What `compare` gives for the count `count` and `expected`. */
export function compareCount(count: number, compare: CountCompare, expected: number): boolean {
  switch (compare) {
    case "equal":
      return count === expected;
    case "not-equal":
      return count !== expected;
    case "greater-than":
      return count > expected;
    case "at-least":
      return count >= expected;
    case "less-than":
      return count < expected;
    case "at-most":
      return count <= expected;
  }
}

/** What `compare` gives for every whole count in `range`: `held` when it
 * holds for all, `broken` when it holds for none, `unknown` when the
 * counts disagree. Pure. */
export function judgeRange(range: CountRange, compare: CountCompare, expected: number): "held" | "broken" | "unknown" {
  const low = range.at_least;
  const high = range.at_most;
  const answer = (holds: boolean, breaks: boolean): "held" | "broken" | "unknown" => (holds ? "held" : breaks ? "broken" : "unknown");
  // A count is a whole number, so it never equals a fraction.
  const within = Number.isInteger(expected) && expected >= low && (high === null || expected <= high);
  switch (compare) {
    case "equal":
      return answer(within && high === low, !within);
    case "not-equal":
      return answer(!within, within && high === low);
    case "greater-than":
      return answer(low > expected, high !== null && high <= expected);
    case "at-least":
      return answer(low >= expected, high !== null && high < expected);
    case "less-than":
      return answer(high !== null && high < expected, low >= expected);
    case "at-most":
      return answer(high !== null && high <= expected, low > expected);
  }
}

/** A reading of one selection, as the claim judges it: its range, and
 * what keeps the range from being one number. `events_read.<key>` of a
 * step record is one. */
export interface CountReading {
  readonly range: CountRange;
  readonly whole: boolean;
  readonly open: readonly EventsGap[];
  readonly maybe: MaybeCounts;
}

export type CountJudgment =
  | { readonly outcome: "held" | "broken" }
  /** `gap` is the first gap of a reading that is not whole, `null` for a
   * whole one whose lines that may match leave the answer open. */
  | { readonly outcome: "unjudged"; readonly reason: string; readonly gap: GapWord | null };

function lines(count: number): string {
  return count === 1 ? "1 line" : `${count} lines`;
}

/** The words of one gap, as a reason uses them. */
export function describeGap(gap: EventsGap): string {
  switch (gap.gap) {
    case "inlet-unnamed":
      return "the program file names no {events}, so the program has no events file";
    case "world-unread":
      return "nukadoko did not start the world's program, so it reads no events there";
    case "producer-not-run":
      return "no earlier line of the scenario ran the step whose events are read";
    case "no-requests":
      return "the step sent the world no request with a traceparent and ran no process";
    case "processes-unbounded":
      return "the step ran a process, and no line can say that every request it sent the world reported";
    case "no-lines":
      return "no line carries the step's trace id";
    case "request-unreported":
      return gap.requests === 1 ? "1 of the step's requests has no request line" : `${gap.requests} of the step's requests have no request line`;
    case "jobs-pending":
      return gap.job_ids.length === 1 ? `job ${gap.job_ids[0]} was enqueued and has not performed` : `jobs ${gap.job_ids.join(", ")} were enqueued and have not performed`;
    case "kind-unreported":
      return `the program has reported no ${gap.kind} line in this world`;
    case "unreadable":
      return `${lines(gap.lines)} of the trace could not be read`;
    case "truncated":
      return "the lines came to more than the record's file holds";
    case "file-replaced":
      return "the events file was replaced or made shorter while it was read";
  }
}

/** Each cause in words, for one line and for several. */
const CAUSE_WORDS: Readonly<Record<(typeof MAYBE_CAUSES)[number], readonly [string, string]>> = {
  unreadable: ["could not be read", "could not be read"],
  undefined_kind: ["is of a kind the format does not define", "are of a kind the format does not define"],
  unknown_version: ["is of a later version", "are of a later version"],
  field_unknown: ["lacks a selected field or holds an invalid one", "lack a selected field or hold an invalid one"],
  commit_unknown: ["has a commit state no line decides", "have a commit state no line decides"],
  unowned: ["carries no step's trace id and may be the step's", "carry no step's trace id and may be the step's"],
};

/** The lines that may match, by cause: `1 line could not be read, 2 lines
 * have a commit state no line decides`. */
export function describeMaybe(maybe: MaybeCounts): string {
  return MAYBE_CAUSES.filter((cause) => maybe[cause] > 0)
    .map((cause) => `${lines(maybe[cause])} ${CAUSE_WORDS[cause][maybe[cause] === 1 ? 0 : 1]}`)
    .join(", ");
}

/** The range in words: `exactly 2`, `between 1 and 3`, `at least 1, with
 * no upper bound`. */
export function describeRange(range: CountRange): string {
  if (range.at_most === null) return `at least ${range.at_least}, with no upper bound`;
  return range.at_most === range.at_least ? `exactly ${range.at_least}` : `between ${range.at_least} and ${range.at_most}`;
}

/** The gaps that say nothing was read, rather than that what was read
 * may lack lines. */
const UNREAD_GAPS: ReadonlySet<GapWord> = new Set(["inlet-unnamed", "world-unread", "producer-not-run"]);

/** Judges `compare` between a count in `reading.range` and `expected`:
 * `held` or `broken` only when every count in the range gives that
 * answer, `unjudged` with the reason and the gap word otherwise. `of`
 * names the step whose events were read, in the reason. Pure. */
export function judgeCount(reading: CountReading, compare: CountCompare, expected: number, of?: string): CountJudgment {
  const answer = judgeRange(reading.range, compare, expected);
  if (answer !== "unknown") return { outcome: answer };
  const first = reading.whole ? undefined : reading.open[0];
  const may = describeMaybe(reading.maybe);
  const events = of === undefined ? "the events" : `the events of ${of}`;
  const state = first !== undefined && UNREAD_GAPS.has(first.gap) ? "were not read" : "are not whole";
  const why = first !== undefined ? `${events} ${state} (${first.gap}): ${describeGap(first)}` : may !== "" ? may : `${events} are not whole`;
  return {
    outcome: "unjudged",
    reason: `${why}, so the count is ${describeRange(reading.range)}, and ${compare} ${expected} is not known`,
    gap: first?.gap ?? null,
  };
}
