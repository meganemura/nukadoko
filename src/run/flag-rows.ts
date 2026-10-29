import { EVENT_KINDS, type FlagEvaluation } from "../execution-events/format.js";
import type { RunFlagCell, RunFlagCounts, RunFlagCriterion, RunFlagRow, RunScenario, RunTable, RunTableRow } from "../record/run-result.js";

// Responsibility: run.json's `flags` (docs/spec.md "Execution events"):
// the verdict table read once per flag and side that the program's flag
// lines name, so a reader deciding whether to turn a flag on finds which
// criteria ran on each side, what their cells came to there, and what
// their rows proved. Pure. Boundary: which flags a step's trace evaluated
// is read when the world stops (src/context/events-file.ts), and the
// table is src/run/verdict-table.ts's; this module adds no verdict.
//
// The side is the one the line names. An environment's `conditions` are
// a declaration, and a scenario can switch a flag for one actor inside a
// world declared off, so one execution can evaluate both sides, and then
// its criterion stands in both rows.
//
// Only head's executions are read: the base world runs the ref's code,
// and the old world the ref's criteria, so their cells are read in the
// table, where they already decide each row's verdict.
//
// A criterion counts under its row's verdict only where it has a required
// cell on the side: a required cell there that did not pass made the row
// red, so a red count is never hidden. A criterion seen on the side only
// in controls counts as `controls`, since its verdict is what its required
// cells on another side came to: counted under it, a control here would
// read as that verdict standing on this side.

export interface FlagRowsInput {
  /** Every execution of the run. */
  readonly scenarios: readonly Pick<RunScenario, "scenario_record_id" | "feature" | "line" | "environment" | "world">[];
  /** The flags an execution's steps evaluated, by its scenario record id. */
  readonly evaluated: (scenarioRecordId: string) => readonly FlagEvaluation[];
  readonly table: Pick<RunTable, "rows">;
}

const FORMAT_GATES: readonly string[] = EVENT_KINDS.flag.gate.values;

// The format's gates first, in its order, then a word it does not define,
// then `null`, so a reader that looks for `boolean` finds it first.
function gateOrder(gate: string | null): [number, string] {
  if (gate === null) return [FORMAT_GATES.length + 1, ""];
  const known = FORMAT_GATES.indexOf(gate);
  return [known === -1 ? FORMAT_GATES.length : known, gate];
}

function byGate(a: string | null, b: string | null): number {
  const [rankA, wordA] = gateOrder(a);
  const [rankB, wordB] = gateOrder(b);
  return rankA - rankB || (wordA < wordB ? -1 : wordA > wordB ? 1 : 0);
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Side {
  readonly name: string;
  readonly side: string;
  /** Gates by cell environment, by the row's place in the table. */
  readonly rows: Map<number, Map<string, Set<string | null>>>;
}

function countsOf(criteria: readonly RunFlagCriterion[]): RunFlagCounts {
  const counts = { held: 0, proven: 0, failed: 0, unproven: 0, moved: 0, controls: 0 };
  for (const criterion of criteria) {
    if (criterion.cells.some((cell) => cell.role === "required")) counts[criterion.verdict] += 1;
    else counts.controls += 1;
  }
  return counts;
}

/** One row per flag and side the head executions' flag lines name, by
 * flag name and then side; `[]` when they name none. Pure. */
export function flagRows(input: FlagRowsInput): RunFlagRow[] {
  const place = new Map(input.table.rows.map((row, index) => [`${row.feature}\u0000${row.line}`, index]));
  const sides = new Map<string, Side>();
  for (const scenario of input.scenarios) {
    if (scenario.world !== undefined) continue;
    const index = place.get(`${scenario.feature}\u0000${scenario.line}`);
    if (index === undefined) continue;
    for (const evaluation of input.evaluated(scenario.scenario_record_id)) {
      const key = JSON.stringify([evaluation.name, evaluation.side]);
      const side = sides.get(key) ?? { name: evaluation.name, side: evaluation.side, rows: new Map() };
      sides.set(key, side);
      const cells = side.rows.get(index) ?? new Map<string, Set<string | null>>();
      side.rows.set(index, cells);
      const gates = cells.get(scenario.environment) ?? new Set<string | null>();
      cells.set(scenario.environment, gates);
      gates.add(evaluation.gate);
    }
  }
  const criterionOf = (row: RunTableRow, cells: Map<string, Set<string | null>>): RunFlagCriterion | undefined => {
    // A removed row has no cells, and so no execution to read.
    if (row.verdict === "removed") return undefined;
    const onSide: RunFlagCell[] = row.cells.flatMap((cell) => {
      const gates = cell.world === "head" ? cells.get(cell.environment) : undefined;
      if (gates === undefined) return [];
      return [{ environment: cell.environment, role: cell.role, outcome: cell.outcome, ...(cell.line === undefined ? {} : { line: cell.line }), gates: [...gates].sort(byGate) }];
    });
    return onSide.length === 0 ? undefined : { feature: row.feature, line: row.line, name: row.name, verdict: row.verdict, cells: onSide };
  };
  return [...sides.values()]
    .sort((a, b) => byText(a.name, b.name) || byText(a.side, b.side))
    .flatMap((side) => {
      const criteria = [...side.rows]
        .sort(([a], [b]) => a - b)
        .flatMap(([index, cells]) => criterionOf(input.table.rows[index]!, cells) ?? []);
      return criteria.length === 0 ? [] : [{ name: side.name, side: side.side, criteria, counts: countsOf(criteria) }];
    });
}
