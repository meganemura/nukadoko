import type { FlagEvaluation } from "../execution-events/format.js";
import type { ListedFlag } from "../execution-events/lists.js";
import { byGate } from "../execution-events/path.js";
import type { RunFlagRow, RunScenario, RunTable } from "../record/run-result.js";
import { countsOf, criteriaByPlace } from "./place-criteria.js";

// Responsibility: run.json's `flags` (docs/spec.md "Execution events"):
// the verdict table read once per flag and side that the program's flag
// lines name, so a reader deciding whether to turn a flag on finds which
// criteria ran on each side, what their cells came to there, and what
// their rows proved. Pure. Boundary: which flags a step's trace evaluated
// is read when the world stops (src/context/events-file.ts), and how a
// criterion stands at a place, which executions count, and how it is
// counted, is src/run/place-criteria.ts's; this module adds no verdict.
//
// The side is the one the line names. An environment's `conditions` are
// a declaration, and a scenario can switch a flag for one actor inside a
// world declared off, so one execution can evaluate both sides, and then
// its criterion stands in both rows.
//
// When a head world read the program's flags list (docs/spec.md "Lists"),
// every side it declares has a row, so a side no criterion evaluated
// stands beside the ones that were, with no criterion; and every row
// names the environments whose list declares its side, so a side the
// lines named and no list declares is told apart. With no list read, the
// rows are only what the lines named, as they were before lists. A flag
// whose lines named one side alone marks that row, since a reader about
// to turn the flag on would otherwise read the other side's absence as
// nothing to see there.

export interface FlagRowsInput {
  /** Every execution of the run. */
  readonly scenarios: readonly Pick<RunScenario, "scenario_record_id" | "feature" | "line" | "environment" | "world">[];
  readonly table: Pick<RunTable, "rows">;
  /** The flags an execution's steps evaluated, by its scenario record id. */
  readonly evaluated: (scenarioRecordId: string) => readonly FlagEvaluation[];
  /** Each environment whose flags list was read, with the list, in the
   * run's order; none when no world read one. */
  readonly listed?: readonly { readonly environment: string; readonly flags: readonly ListedFlag[] }[];
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const keyOf = ({ name, side }: { readonly name: string; readonly side: string }): string => JSON.stringify([name, side]);

/** One row per flag and side the head executions' flag lines name, and
 * per side a read flags list declares, by flag name and then side; `[]`
 * when there is neither. Pure. */
export function flagRows(input: FlagRowsInput): RunFlagRow[] {
  const evaluated = criteriaByPlace({
    scenarios: input.scenarios,
    table: input.table,
    visits: (id) => input.evaluated(id).map(({ name, side, gate }) => ({ place: { name, side }, detail: gate })),
    keyOf,
    cellOf: (gates) => ({ gates: [...new Set(gates)].sort(byGate) }),
  });
  const listed = input.listed ?? [];
  const sides = new Map<string, { readonly name: string; readonly side: string; readonly listedIn: string[] }>();
  for (const { place, criteria } of evaluated.values()) {
    if (criteria.length > 0) sides.set(keyOf(place), { ...place, listedIn: [] });
  }
  for (const { environment, flags } of listed) {
    for (const flag of flags) {
      for (const side of flag.sides) {
        const key = keyOf({ name: flag.name, side });
        const entry = sides.get(key) ?? { name: flag.name, side, listedIn: [] };
        sides.set(key, entry);
        if (!entry.listedIn.includes(environment)) entry.listedIn.push(environment);
      }
    }
  }
  const sidesEvaluated = new Map<string, number>();
  for (const { place, criteria } of evaluated.values()) {
    if (criteria.length > 0) sidesEvaluated.set(place.name, (sidesEvaluated.get(place.name) ?? 0) + 1);
  }
  return [...sides.entries()]
    .sort(([, a], [, b]) => byText(a.name, b.name) || byText(a.side, b.side))
    .map(([key, { name, side, listedIn }]): RunFlagRow => {
      const criteria = evaluated.get(key)?.criteria ?? [];
      return {
        name,
        side,
        criteria,
        counts: countsOf(criteria),
        ...(listed.length === 0 ? {} : { listed_in: listedIn }),
        ...(criteria.length > 0 && sidesEvaluated.get(name) === 1 ? { only_side_evaluated: true as const } : {}),
      };
    });
}
