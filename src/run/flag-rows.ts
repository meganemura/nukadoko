import { EVENT_KINDS, type FlagEvaluation } from "../execution-events/format.js";
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

export interface FlagRowsInput {
  /** Every execution of the run. */
  readonly scenarios: readonly Pick<RunScenario, "scenario_record_id" | "feature" | "line" | "environment" | "world">[];
  readonly table: Pick<RunTable, "rows">;
  /** The flags an execution's steps evaluated, by its scenario record id. */
  readonly evaluated: (scenarioRecordId: string) => readonly FlagEvaluation[];
}

const FORMAT_GATES: readonly string[] = EVENT_KINDS.flag.gate.values;

// The format's gates first, in its order, then a word it does not define,
// then `null`, so a reader that looks for `boolean` finds it first.
function gateOrder(gate: string | null): [number, string] {
  if (gate === null) return [FORMAT_GATES.length + 1, ""];
  const known = FORMAT_GATES.indexOf(gate);
  return [known === -1 ? FORMAT_GATES.length : known, gate];
}

/** The order of a cell's `gates`, which the run summary keeps too. */
export function byGate(a: string | null, b: string | null): number {
  const [rankA, wordA] = gateOrder(a);
  const [rankB, wordB] = gateOrder(b);
  return rankA - rankB || (wordA < wordB ? -1 : wordA > wordB ? 1 : 0);
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One row per flag and side the head executions' flag lines name, by
 * flag name and then side; `[]` when they name none. Pure. */
export function flagRows(input: FlagRowsInput): RunFlagRow[] {
  const sides = criteriaByPlace({
    scenarios: input.scenarios,
    table: input.table,
    visits: (id) => input.evaluated(id).map(({ name, side, gate }) => ({ place: { name, side }, detail: gate })),
    keyOf: ({ name, side }) => JSON.stringify([name, side]),
    cellOf: (gates) => ({ gates: [...new Set(gates)].sort(byGate) }),
  });
  return [...sides.values()]
    .sort((a, b) => byText(a.place.name, b.place.name) || byText(a.place.side, b.place.side))
    .flatMap(({ place, criteria }) => (criteria.length === 0 ? [] : [{ name: place.name, side: place.side, criteria, counts: countsOf(criteria) }]));
}
