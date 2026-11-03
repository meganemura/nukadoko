import { requestKey, type StepPath } from "../execution-events/path.js";
import type { Finding } from "../finding/finding.js";
import { runCodeInfo } from "../finding/run-codes.js";
import { shellWord } from "../shell/shell-word.js";
import type { RunIntent, RunIntentRow, RunPathComparison, RunPathCriterion, RunPathDifference, RunPathStep, RunScenario, RunTableRow } from "../record/run-result.js";
import { rowDeclares, rowObserves, type Intent, type IntentRow } from "./intent.js";

// Responsibility: what each row of a change's intent came to against the
// base pairs of run.json's `paths` (docs/intent.md), and which row declares
// each difference there. Pure: it reads the comparisons, the scenarios
// they name, and each criterion's tags. Boundary: reading the intent is
// src/run/intent.ts's, comparing two paths src/run/path-view.ts's; this
// module adds the account and changes no count.
//
// A row aims at a criterion that carries every tag of its target, and,
// when its target or a bare field reads a line's values, whose steps on
// either side hold an entry those values meet. A row that counts lines
// with no such term aims at every criterion its tags name, since `0 -> 1`
// must be told apart from nothing happening where nothing was there to
// see. Each criterion it aims at either did what it says or did not:
// a row meant to change declares a difference there, and one meant not
// to change finds no difference on what it observes that no other row
// declares. A row that aimed at no compared criterion was not reached:
// the scenarios do not cover it, which another comparison, such as the
// application's own over every contract, may.
//
// A value row declares a difference only in pairs, within one step: the
// lines that held the old value go, and as many that hold the new one
// come. A value that went somewhere else is no such pair, so neither half
// is declared.
//
// Only a decided difference (`changed`) is declared or not: an `open` one
// could still read the same. A changed criterion of a base pair whose
// every difference a row declares, with no step that ran on one side
// alone, is explained by the intent; a new or changed criterion keeps its
// own sentences as the account for the rest; anything else is a
// difference nothing the change declares asked for.

/** Where a criterion is, as a row names it. */
type Place = { readonly feature: string; readonly line: number };

function placeText(place: Place): string {
  return `${place.feature}:${place.line}`;
}

type Keyed = Readonly<Record<string, unknown>> & { readonly kind: string };

function keysOfPath(path: StepPath | undefined): Keyed[] {
  if (path === undefined) return [];
  return [...path.entries, ...path.requests.map(requestKey)] as unknown as Keyed[];
}

/** Whether a row aims at a criterion, from its tags and every entry its
 * two sides' steps hold (module header). */
function aims(row: IntentRow, tags: ReadonlySet<string>, seen: readonly Keyed[]): boolean {
  if (!row.tags.every((tag) => tags.has(tag))) return false;
  if (row.conditions.length === 0 && row.projection === null) return true;
  // A count row's filters name what is counted, which may be absent on
  // both sides; its target alone says where it aims.
  const reads = row.projection === null ? { ...row, filters: [] } : row;
  return seen.some((key) => rowObserves(reads, key));
}

/** The first row that declares each difference of one step, in the
 * rows' order: a count at once, a value in pairs (module header). */
function declared(rows: readonly IntentRow[], aimed: readonly IntentRow[], changed: readonly RunPathDifference[]): Map<RunPathDifference, number> {
  const found = new Map<RunPathDifference, number>();
  for (const row of rows) {
    if (!aimed.includes(row)) continue;
    const gone: RunPathDifference[] = [];
    const came: RunPathDifference[] = [];
    for (const difference of changed) {
      if (found.has(difference) || !rowObserves(row, difference as unknown as Keyed)) continue;
      const how = rowDeclares(row, difference as unknown as Keyed, difference.a, difference.b);
      if (how === "count") found.set(difference, row.row);
      else if (how === "gone") gone.push(difference);
      else if (how === "came") came.push(difference);
    }
    // How many lines went, and how many came: a decided difference's
    // bounds on the side it shrank toward are known.
    const went = gone.reduce((sum, difference) => sum + difference.a.at_least - (difference.b.at_most ?? 0), 0);
    const arrived = came.reduce((sum, difference) => sum + difference.b.at_least - (difference.a.at_most ?? 0), 0);
    if (gone.length > 0 && came.length > 0 && went === arrived) for (const difference of [...gone, ...came]) found.set(difference, row.row);
  }
  return found;
}

export interface JudgedIntent {
  /** The comparisons, each base pair's differences with the row that
   * declares them and its criteria's `explained_by` read again. */
  readonly paths: readonly RunPathComparison[];
  readonly rows: readonly Omit<RunIntentRow, "line" | "target" | "observation" | "before" | "after">[];
}

/** Judges each row against the base pairs of `paths`. `tagsOf` gives a
 * criterion's tags, as head's feature file has them. Pure. */
export function judgeIntent(
  intent: Intent,
  paths: readonly RunPathComparison[],
  scenarios: readonly RunScenario[],
  table: { readonly rows: readonly Pick<RunTableRow, "feature" | "line" | "change">[] },
  tagsOf: (place: Place) => readonly string[],
): JudgedIntent {
  const byId = new Map(scenarios.map((scenario) => [scenario.scenario_record_id, scenario]));
  const changeOf = new Map(table.rows.map((row) => [placeText(row), row.change]));
  const happened = new Map<number, Set<string>>(intent.rows.map((row) => [row.row, new Set()]));
  const missed = new Map<number, Set<string>>(intent.rows.map((row) => [row.row, new Set()]));
  const judge = (criterion: RunPathCriterion): RunPathCriterion => {
    const place = placeText(criterion);
    const tags = new Set(tagsOf(criterion));
    const [a, b] = [byId.get(criterion.a.scenario_record_id), byId.get(criterion.b.scenario_record_id)];
    const seen = [...(a?.steps ?? []), ...(b?.steps ?? [])].flatMap((step) => keysOfPath(step.path));
    const aimed = intent.rows.filter((row) => aims(row, tags, seen));
    const steps: RunPathStep[] = (criterion.steps ?? []).map((step) => {
      if (step.ran !== "both") return step;
      const rows = declared(intent.rows, aimed, step.changed);
      return { ...step, changed: step.changed.map((difference) => (rows.has(difference) ? { ...difference, intent: rows.get(difference)! } : difference)) };
    });
    const changed = steps.flatMap((step) => (step.ran === "both" ? step.changed : []));
    for (const row of aimed) {
      const did = row.change === null ? !changed.some((difference) => difference.intent === undefined && rowObserves(row, difference as unknown as Keyed)) : changed.some((difference) => difference.intent === row.row);
      (did ? happened : missed).get(row.row)!.add(place);
    }
    if (criterion.explained_by === undefined) return criterion.steps === undefined ? criterion : { ...criterion, steps };
    const unmarked = changed.filter((difference) => difference.holds === undefined);
    const byIntent = unmarked.length > 0 && unmarked.every((difference) => difference.intent !== undefined) && steps.every((step) => step.ran === "both");
    const change = changeOf.get(place);
    const explained_by = byIntent ? "intent" : change === "new" || change === "changed" ? "criterion_change" : null;
    return { ...criterion, explained_by, steps };
  };
  const judged = paths.map((comparison) => (comparison.between.kind === "base" ? { ...comparison, criteria: comparison.criteria.map(judge) } : comparison));
  const order = new Map(table.rows.map((row, index) => [placeText(row), index]));
  const places = (set: ReadonlySet<string>): Place[] =>
    [...set]
      .sort((x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0))
      .map((text) => {
        const at = text.lastIndexOf(":");
        return { feature: text.slice(0, at), line: Number(text.slice(at + 1)) };
      });
  const rows = intent.rows.map((row) => {
    const missing = missed.get(row.row)!;
    // A criterion that missed in one environment and did it in another
    // did not do it everywhere it was aimed at.
    const did = new Set([...happened.get(row.row)!].filter((place) => !missing.has(place)));
    const result: RunIntentRow["result"] = missing.size > 0 ? "not_happening" : did.size > 0 ? "as_intended" : "not_reached";
    return { row: row.row, result, as_intended: places(did), not_happening: places(missing) };
  });
  return { paths: judged, rows };
}

/** The findings that gate a run whose change declares an intent: each
 * problem reading it, each criterion with a difference nothing the change
 * declares, and each row that did not happen where it aimed. A row not
 * reached gates nothing: the scenarios do not cover it, and another
 * comparison may. `rerun` gives the command that runs one criterion
 * against the same base. Pure. */
export function intentFindings(intent: RunIntent, paths: readonly RunPathComparison[], rerun: (place: Place) => readonly string[]): Finding[] {
  const command = (place: Place): string => rerun(place).map(shellWord).join(" ");
  const findings: Finding[] = intent.problems.map((problem) => ({
    severity: "failed",
    code: "intent-unread",
    file: intent.file,
    ...(problem.line === null ? {} : { line: problem.line }),
    message: `${intent.file} cannot be read as an intent: ${problem.message}`,
    fix: runCodeInfo("intent-unread").fix,
  }));
  const unexplained = new Map<string, RunPathCriterion>();
  for (const comparison of paths) {
    if (comparison.between.kind !== "base") continue;
    for (const criterion of comparison.criteria) if (criterion.explained_by === null) unexplained.set(placeText(criterion), criterion);
  }
  for (const criterion of unexplained.values()) {
    findings.push({
      severity: "failed",
      code: "intent-unintended",
      file: criterion.feature,
      line: criterion.line,
      message: `Scenario "${criterion.name}" did something at head that it did not do at the base, and neither ${intent.file} nor its sentences declare it; "base → head" in the summary lists what`,
      fix: runCodeInfo("intent-unintended").fix.replaceAll("INTENT.md", intent.file),
      do: command(criterion),
    });
  }
  for (const row of intent.rows) {
    if (row.result !== "not_happening") continue;
    const [first] = row.not_happening;
    findings.push({
      severity: "failed",
      code: "intent-not-happening",
      file: intent.file,
      line: row.line,
      message: `row ${row.row} of ${intent.file} did not happen in ${row.not_happening.map(placeText).join(", ")}, which its target names`,
      fix: runCodeInfo("intent-not-happening").fix,
      ...(first === undefined ? {} : { do: command(first) }),
    });
  }
  return findings;
}
