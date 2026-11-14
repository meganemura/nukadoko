import type { RunRowVerdict, RunTable } from "../record/run-result.js";

// Responsibility: what run.json's verdict table (docs/spec.md "Verdicts")
// says of one scenario execution, for the report formats that render one
// execution at a time: the Allure results and the messages stream. The
// row's verdict and its reason, and the role the execution's cell has.
// Boundary: reads the table and nothing else; how each format carries it
// is that format's mapper's.
//
// A control that failed is the execution a format would show red, and the
// one the table reads as proof; without the role and the verdict beside
// it, a reader of a format that shows executions sees a failure where the
// run was green.

export interface ScenarioVerdict {
  /** The row's verdict: the criterion's, across every cell. */
  readonly verdict: RunRowVerdict;
  readonly reason: string;
  /** The role of the cell the execution belongs to. */
  readonly role: "required" | "control";
}

/** The verdict of the row and the role of the cell an execution in
 * `environment` of the scenario at `feature`:`line` belongs to; undefined
 * when the table holds no such cell. Pure. */
export function scenarioVerdictOf(table: RunTable, feature: string, line: number, environment: string): ScenarioVerdict | undefined {
  const row = table.rows.find((entry) => entry.feature === feature && entry.line === line);
  const cell = row?.cells.find((entry) => entry.world === "head" && entry.environment === environment);
  if (row === undefined || cell === undefined) return undefined;
  return { verdict: row.verdict, reason: row.reason, role: cell.role };
}
