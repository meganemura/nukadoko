import type { CountRange } from "../execution-events/count.js";
import { boundingGaps, keysOf, kindRule, rangeOn, type PathKind, type StepPath } from "../execution-events/path.js";
import type { TraceGap } from "../execution-events/tally.js";
import type {
  RunDocument,
  RunPathComparison,
  RunPathCriterion,
  RunPathDifference,
  RunPathExecution,
  RunPathSide,
  RunPathStep,
  RunScenario,
  RunTableRow,
} from "../record/run-result.js";

// Responsibility: run.json's `paths` (docs/spec.md "Execution events"):
// for each pair of sides the run can compare, what each criterion's
// steps did differently on one side than on the other, as their paths
// say (src/execution-events/path.ts), so a person about to turn a change
// on for everyone reads what changed in what the program did. Pure: it
// reads run.json's own fields and nothing else, so a later reader can
// compare two documents without reading a line of events again.
// Boundary: a path, and the range a count on it lies in, are
// path.ts's; the cells and their outcomes are the table's; this module
// adds no verdict.
//
// A pair is two sides of one criterion. Under `nuka run --base`, each
// environment's base world is paired with its head world, for the rows
// whose head cell there is required and ran. Otherwise it is two head
// environments whose declared `conditions` differ in exactly one
// condition: the fixture's `reorder-off` and `reorder-on` make one. The
// base world runs head's pickle too, since its tree holds head's features
// directory, so on either kind of pair steps align by their line in head's
// feature file, and a criterion whose two step lists differ is not
// compared. The old world runs the ref's feature file, so it is never a
// side. A side is read from its cell's first execution, since repeats and
// proof runs add more.
//
// Two counts are the same when both are exact and equal, changed when
// their ranges cannot meet, and open otherwise: a count a side's missing
// lines could still reach never reads as a change. A criterion whose
// every open count reads the same on both sides, under the same gap
// words, is `same_so_far`: correct as `open` is, but nothing the run
// saw differs, so a reader is not sent to it first. In a pair of
// environments, a flag's side differing is the switch the pair was made
// to compare, so a kind PATH_KINDS marks as the premise is named in the
// pair's heading and never among what changed. Against the base, a
// flag's side is what the program did, so it is compared as any kind is.

type ComparedDocument = Pick<RunDocument, "scenarios" | "table" | "environments" | "worlds">;

interface Pair {
  readonly between: RunPathComparison["between"];
  readonly a: RunPathSide;
  readonly b: RunPathSide;
}

/** Under `--base`, each environment's base world against its head
 * world, in the run's order of environments. */
function basePairs(document: ComparedDocument): Pair[] {
  if (document.table.base === null) return [];
  return document.environments.map(({ name }) => ({ between: { kind: "base" }, a: { world: "base", environment: name }, b: { world: "head", environment: name } }));
}

/** Every two environments whose declared conditions differ in exactly
 * one, in the run's order: side `a` holds `false` or no value where `b`
 * holds `true`, and otherwise the earlier environment. */
function conditionPairs(environments: ComparedDocument["environments"]): Pair[] {
  const pairs: Pair[] = [];
  environments.forEach((first, index) => {
    for (const second of environments.slice(index + 1)) {
      const one = first.conditions ?? {};
      const other = second.conditions ?? {};
      const differ = [...new Set([...Object.keys(one), ...Object.keys(other)])].filter((name) => one[name] !== other[name]);
      if (differ.length !== 1) continue;
      const name = differ[0]!;
      const flipped = one[name] === true && (other[name] === false || other[name] === undefined);
      const [a, b] = flipped ? [second, first] : [first, second];
      pairs.push({
        between: { kind: "condition", name, a: a.conditions?.[name] ?? null, b: b.conditions?.[name] ?? null },
        a: { world: "head", environment: a.name },
        b: { world: "head", environment: b.name },
      });
    }
  });
  return pairs;
}

/** Whether a side's world read its events, or why it gave no paths.
 * `none`: no base world started in the environment, since no row ran
 * there, which each criterion's `not_compared` says. A base side's
 * reason names no environment, so the summary says it once for all. */
function readingOf(document: ComparedDocument, side: RunPathSide): "read" | "none" | { readonly unread: string } {
  const world = (document.worlds ?? []).find((entry) => (entry.tree ?? "head") === side.world && entry.name === side.environment);
  const base = side.world === "base";
  if (world === undefined && base) return "none";
  const named = base ? "the base world" : `world ${side.environment}`;
  if (world === undefined || world.error !== null) return { unread: `the program did not start for ${named}` };
  if (world.events === null) return { unread: `${named} runs at ${world.url ?? "a url"}, which nukadoko did not start, so it read no execution events there` };
  if (world.events === undefined) return { unread: base ? "the base's program file names no {events}, so the base world wrote no execution events" : `the program file of ${named} names no {events}, so it wrote no execution events` };
  return "read";
}

/** Where a side ran, as a reason names it: `at the base`, `at head`, or
 * in its environment. */
function sideWhere(pair: Pair, side: RunPathSide): string {
  if (pair.between.kind === "base") return side.world === "base" ? "at the base" : "at head";
  return `in ${side.environment}`;
}

function sameRow(scenario: RunScenario, row: RunTableRow, side: RunPathSide): boolean {
  const at = scenario.row ?? scenario;
  return (scenario.world ?? "head") === side.world && scenario.environment === side.environment && at.feature === row.feature && at.line === row.line;
}

/** A side's first execution of a row, with what its cell came to, or
 * `undefined` when the side did not run the row. */
function sideOf(document: ComparedDocument, row: RunTableRow, side: RunPathSide): { readonly scenario: RunScenario; readonly execution: RunPathExecution } | undefined {
  const scenario = document.scenarios.find((entry) => sameRow(entry, row, side));
  const cell = row.cells.find((entry) => entry.world === side.world && entry.environment === side.environment);
  if (scenario === undefined || cell === undefined) return undefined;
  return { scenario, execution: { scenario_record_id: scenario.scenario_record_id, outcome: cell.outcome, ...(cell.line === undefined ? {} : { line: cell.line }) } };
}

/** Whether a pair compares a row: against the base, where the row's head
 * cell is required and ran, which is where the base runs it; between two
 * environments, every row. */
function pairCompares(pair: Pair, row: RunTableRow): boolean {
  if (pair.between.kind === "condition") return true;
  const head = row.cells.find((cell) => cell.world === "head" && cell.environment === pair.b.environment);
  return head !== undefined && head.role === "required" && head.outcome !== "not-run";
}

function exact(range: CountRange): boolean {
  return range.at_most === range.at_least;
}

function apart(a: CountRange, b: CountRange): boolean {
  return (a.at_most !== null && a.at_most < b.at_least) || (b.at_most !== null && b.at_most < a.at_least);
}

function gapWords(gaps: readonly TraceGap[]): string {
  return JSON.stringify([...new Set(gaps.map((gap) => gap.gap))].sort());
}

/** Whether an open step reads the same on both sides so far: every open
 * count has one range on both, under the same gap words. */
function sameSoFar(step: Extract<RunPathStep, { ran: "both" }>): boolean {
  return step.open.every(({ a, b }) => a.at_least === b.at_least && a.at_most === b.at_most) && gapWords(step.gaps.a) === gapWords(step.gaps.b);
}

/** What changed between two paths of one step, over the kinds `compared`
 * keeps. */
function stepDifference(a: StepPath, b: StepPath, compared: (kind: PathKind) => boolean): Pick<Extract<RunPathStep, { ran: "both" }>, "changed" | "open"> {
  const keys = keysOf(a, b).filter((key) => compared(key.kind));
  const changed: RunPathDifference[] = [];
  const open: RunPathDifference[] = [];
  for (const key of keys) {
    const ranges = { a: rangeOn(a, key), b: rangeOn(b, key) };
    if (exact(ranges.a) && exact(ranges.b) && ranges.a.at_least === ranges.b.at_least) continue;
    (apart(ranges.a, ranges.b) ? changed : open).push({ ...key, ...ranges });
  }
  return { changed, open };
}

type Compared = { readonly criterion: RunPathCriterion } | { readonly reason: string };

type Side = NonNullable<ReturnType<typeof sideOf>>;

function compareCriterion(pair: Pair, row: RunTableRow, sides: readonly [Side, Side], compared: (kind: PathKind) => boolean): Compared {
  const [stepsA, stepsB] = [sides[0].scenario.steps, sides[1].scenario.steps];
  if (stepsA.length !== stepsB.length || stepsA.some((step, index) => step.line !== stepsB[index]!.line)) {
    return { reason: "ran steps that differ between the two sides, which run one pickle, a bug in nukadoko" };
  }
  const steps: RunPathStep[] = [];
  for (const [index, stepA] of stepsA.entries()) {
    const stepB = stepsB[index]!;
    const ranA = stepA.record !== null;
    const ranB = stepB.record !== null;
    if (ranA !== ranB) {
      steps.push({ line: stepA.line, text: stepA.text, ran: ranA ? "a" : "b" });
      continue;
    }
    if (!ranA) continue;
    if (stepA.path === undefined || stepB.path === undefined) {
      return { reason: `kept no path of its step at line ${stepA.line ?? "unknown"} ${sideWhere(pair, stepA.path === undefined ? pair.a : pair.b)}` };
    }
    const { changed, open } = stepDifference(stepA.path, stepB.path, compared);
    if (changed.length > 0 || open.length > 0) steps.push({ line: stepA.line, text: stepA.text, ran: "both", changed, open, gaps: { a: boundingGaps(stepA.path), b: boundingGaps(stepB.path) } });
  }
  const isChanged = steps.some((step) => step.ran !== "both" || step.changed.length > 0);
  const result = isChanged ? "changed" : steps.length === 0 ? "same" : steps.every((step) => step.ran === "both" && sameSoFar(step)) ? "same_so_far" : "open";
  return {
    criterion: {
      feature: row.feature,
      line: row.line,
      name: row.name,
      result,
      a: sides[0].execution,
      b: sides[1].execution,
      ...(result === "same" ? {} : { steps }),
    },
  };
}

function comparePair(document: ComparedDocument, pair: Pair): RunPathComparison | undefined {
  const readings = [readingOf(document, pair.a), readingOf(document, pair.b)];
  // Neither side read events: a run of a program that reports none says
  // nothing about paths.
  if (!readings.includes("read")) return undefined;
  const empty = { changed: 0, open: 0, same_so_far: 0, same: 0, not_compared: 0 };
  const base = { between: pair.between, a: pair.a, b: pair.b };
  const why = readings.flatMap((reading) => (typeof reading === "object" ? [reading.unread] : []))[0];
  if (why !== undefined) return { ...base, unread: why, counts: empty, criteria: [], not_compared: [] };
  const compared = (kind: PathKind): boolean => !(pair.between.kind === "condition" && kindRule(kind).conditionPremise === true);
  const criteria: RunPathCriterion[] = [];
  const notCompared: RunPathComparison["not_compared"][number][] = [];
  for (const row of document.table.rows) {
    if (row.verdict === "removed" || !pairCompares(pair, row)) continue;
    const sides = [sideOf(document, row, pair.a), sideOf(document, row, pair.b)] as const;
    const missing = [pair.a, pair.b].find((_, index) => sides[index] === undefined);
    if (missing !== undefined) {
      notCompared.push({ feature: row.feature, line: row.line, reason: `did not run ${sideWhere(pair, missing)}` });
      continue;
    }
    const found = compareCriterion(pair, row, [sides[0]!, sides[1]!], compared);
    if ("reason" in found) notCompared.push({ feature: row.feature, line: row.line, reason: found.reason });
    else criteria.push(found.criterion);
  }
  const count = (result: RunPathCriterion["result"]): number => criteria.filter((criterion) => criterion.result === result).length;
  return { ...base, unread: null, counts: { changed: count("changed"), open: count("open"), same_so_far: count("same_so_far"), same: count("same"), not_compared: notCompared.length }, criteria, not_compared: notCompared };
}

/** One comparison per pair of sides the run can compare: each base pair,
 * then each pair of environments, in the run's order of environments;
 * `[]` when there is none. Pure. */
export function comparePaths(document: ComparedDocument): RunPathComparison[] {
  return [...basePairs(document), ...conditionPairs(document.environments)].flatMap((pair) => comparePair(document, pair) ?? []);
}
