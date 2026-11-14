import type { RunPlaceCell, RunPlaceCounts, RunPlaceCriterion, RunScenario, RunTable } from "../record/run-result.js";

// Responsibility: the verdict table read once per place of the program
// that the head executions' event lines reached, a flag's side or a
// route, for run.json's `flags` and `routes` (docs/spec.md "Execution
// events" and "Lists"): which criteria reached each place, with their
// table row's verdict and their cells there, and their counts by
// verdict. One reading for every kind of place, so a criterion stands
// under a flag and under a route by the same rule. Pure. Boundary: what
// an execution's lines reached is read when its world stops
// (src/context/events-file.ts), what a cell gains from those lines is
// the caller's, and the table is src/run/verdict-table.ts's; this module
// adds no verdict.
//
// Only head's executions are read: the base world runs the ref's code,
// and the old world the ref's criteria, so their cells are read in the
// table, where they already decide each row's verdict.
//
// A criterion counts under its row's verdict only where it has a required
// cell at the place: a required cell there that did not pass made the row
// red, so a red count is never hidden. A criterion seen at the place only
// in controls counts as `controls`, since its verdict is what its required
// cells elsewhere came to: counted under it, a control here would read as
// that verdict standing at this place.

/** One place an execution's steps reached, with what one of its lines
 * said there. */
export interface Visit<Place, Detail> {
  readonly place: Place;
  readonly detail: Detail;
}

/** The run whose table a place's criteria come from. */
export interface PlaceRun {
  /** Every execution of the run. */
  readonly scenarios: readonly Pick<RunScenario, "scenario_record_id" | "feature" | "line" | "environment" | "world">[];
  readonly table: Pick<RunTable, "rows">;
}

export interface PlaceCriteriaInput<Place, Detail, Cell extends object> extends PlaceRun {
  /** Each visit of an execution's steps, by its scenario record id. */
  readonly visits: (scenarioRecordId: string) => Iterable<Visit<Place, Detail>>;
  /** The same text for the same place, and another for any other. */
  readonly keyOf: (place: Place) => string;
  /** What a cell holds beyond the table's own fields, from the details
   * of every visit its executions made at the place. */
  readonly cellOf: (details: readonly Detail[]) => Cell;
}

export interface PlaceCriteria<Place, Cell extends object> {
  readonly place: Place;
  /** Each criterion whose head executions reached the place, in the
   * table's row order, with its cells there in the table's column order. */
  readonly criteria: readonly RunPlaceCriterion<RunPlaceCell & Cell>[];
}

interface Reached<Place, Detail> {
  readonly place: Place;
  /** The details of each visit, by cell environment, by the row's place
   * in the table. */
  readonly rows: Map<number, Map<string, Detail[]>>;
}

/** Each place the head executions reached, by its key, in the order of
 * its first visit. Pure. */
export function criteriaByPlace<Place, Detail, Cell extends object>(input: PlaceCriteriaInput<Place, Detail, Cell>): Map<string, PlaceCriteria<Place, Cell>> {
  const rowIndex = new Map(input.table.rows.map((row, index) => [`${row.feature}\u0000${row.line}`, index]));
  const reached = new Map<string, Reached<Place, Detail>>();
  for (const scenario of input.scenarios) {
    if (scenario.world !== undefined) continue;
    const index = rowIndex.get(`${scenario.feature}\u0000${scenario.line}`);
    if (index === undefined) continue;
    for (const visit of input.visits(scenario.scenario_record_id)) {
      const key = input.keyOf(visit.place);
      const at = reached.get(key) ?? { place: visit.place, rows: new Map() };
      reached.set(key, at);
      const cells = at.rows.get(index) ?? new Map<string, Detail[]>();
      at.rows.set(index, cells);
      const details = cells.get(scenario.environment) ?? [];
      cells.set(scenario.environment, details);
      details.push(visit.detail);
    }
  }
  const criterionOf = (index: number, cells: Map<string, Detail[]>): RunPlaceCriterion<RunPlaceCell & Cell> | undefined => {
    const row = input.table.rows[index]!;
    // A removed row has no cells, and so no execution to read.
    if (row.verdict === "removed") return undefined;
    const atPlace = row.cells.flatMap((cell) => {
      const details = cell.world === "head" ? cells.get(cell.environment) : undefined;
      if (details === undefined) return [];
      return [{ environment: cell.environment, role: cell.role, outcome: cell.outcome, ...(cell.line === undefined ? {} : { line: cell.line }), ...input.cellOf(details) }];
    });
    return atPlace.length === 0 ? undefined : { feature: row.feature, line: row.line, name: row.name, verdict: row.verdict, cells: atPlace };
  };
  return new Map(
    [...reached].map(([key, at]) => [
      key,
      {
        place: at.place,
        criteria: [...at.rows].sort(([a], [b]) => a - b).flatMap(([index, cells]) => criterionOf(index, cells) ?? []),
      },
    ]),
  );
}

/** A place's criteria by their row's verdict (module header). */
export function countsOf(criteria: readonly RunPlaceCriterion<RunPlaceCell>[]): RunPlaceCounts {
  const counts = { held: 0, proven: 0, failed: 0, unproven: 0, moved: 0, controls: 0 };
  for (const criterion of criteria) {
    if (criterion.cells.some((cell) => cell.role === "required")) counts[criterion.verdict] += 1;
    else counts.controls += 1;
  }
  return counts;
}
