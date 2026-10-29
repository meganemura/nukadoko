import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import type { FlagEvaluation } from "../src/execution-events/format.js";
import type { RunScenario } from "../src/record/run-result.js";
import { flagRows } from "../src/run/flag-rows.js";
import { buildTable, type ExecutionOutcome } from "../src/run/verdict-table.js";

// Responsibility: the properties of run.json's `flags` over runs the
// verdict table judges as `nuka run` does: two environments that declare
// the two sides of a condition, criteria tagged with it or not, each
// execution with its own outcome and its own flag lines, and executions
// of the base world mixed in. Every flag line of a head execution lands
// in exactly one row per side and in one cell there; no row holds a cell
// no line put there; a row's counts sum to its criteria; and a criterion
// is counted under a verdict only where a required cell of it stands on
// the row's side, so a control that broke there is never counted as
// proof. The exact rows of a real run are tests/program-events-flags.test.ts's.

const ENVIRONMENTS = [
  { name: "x-off", conditions: { x: false } },
  { name: "x-on", conditions: { x: true } },
] as const;

interface Execution {
  readonly id: string;
  readonly criterion: number;
  readonly environment: string;
  readonly world?: "base";
  readonly outcome: ExecutionOutcome;
  readonly evaluations: readonly FlagEvaluation[];
}

const evaluation = gs.composite((tc) => ({
  name: tc.draw(gs.sampledFrom(["a", "b"])),
  side: tc.draw(gs.sampledFrom(["on", "off", "blue"])),
  gate: tc.draw(gs.sampledFrom(["boolean", "actor", "percentage", "manual", null])),
}));

const outcome = gs.sampledFrom<ExecutionOutcome>([
  { kind: "pass" },
  { kind: "fail", line: 3, claim: 0, actual: { value: 1 } },
  { kind: "broke", line: 2 },
]);

const runGen = gs.composite((tc) => {
  const tagged = tc.draw(gs.arrays(gs.booleans(), { minSize: 1, maxSize: 4 }));
  const executions: Execution[] = [];
  for (const [criterion] of tagged.entries()) {
    for (const environment of ENVIRONMENTS) {
      const runs = tc.draw(gs.integers({ minValue: 1, maxValue: 2 }));
      for (let run = 0; run < runs; run += 1) {
        executions.push({
          id: `scn-${executions.length}`,
          criterion,
          environment: environment.name,
          ...(tc.draw(gs.integers({ minValue: 0, maxValue: 4 })) === 0 ? { world: "base" as const } : {}),
          outcome: tc.draw(outcome),
          evaluations: tc.draw(gs.arrays(evaluation, { maxSize: 3 })),
        });
      }
    }
  }
  return { tagged, executions };
});

function build(tagged: readonly boolean[], executions: readonly Execution[]) {
  const table = buildTable({
    criteria: tagged.map((withX, index) => ({ feature: "features/f.feature", line: index + 1, name: `c${index}`, tags: withX ? ["@with:x"] : [] })),
    environments: ENVIRONMENTS,
    outcomes: (_feature, line, environment, world = "head") =>
      executions
        .filter((entry) => entry.criterion === line - 1 && entry.environment === environment && (entry.world ?? "head") === world)
        .map((entry) => entry.outcome),
    notRunReason: () => undefined,
    proofRuns: 2,
    leftOut: 0,
  });
  const scenarios: Pick<RunScenario, "scenario_record_id" | "feature" | "line" | "environment" | "world">[] = executions.map((entry) => ({
    scenario_record_id: entry.id,
    feature: "features/f.feature",
    line: entry.criterion + 1,
    environment: entry.environment,
    ...(entry.world === undefined ? {} : { world: entry.world }),
  }));
  const evaluated = new Map(executions.map((entry) => [entry.id, entry.evaluations]));
  return { table, rows: flagRows({ scenarios, evaluated: (id) => evaluated.get(id) ?? [], table }) };
}

describe("run.json's flags", () => {
  it("puts every flag line of a head execution in one row per side, in one cell, with its gate", () =>
    hegel.test((tc) => {
      const { tagged, executions } = tc.draw(runGen);
      const { rows } = build(tagged, executions);
      for (const execution of executions) {
        if (execution.world !== undefined) continue;
        for (const line of execution.evaluations) {
          const matching = rows.filter((row) => row.name === line.name && row.side === line.side);
          expect(matching).toHaveLength(1);
          const criteria = matching[0]!.criteria.filter((entry) => entry.line === execution.criterion + 1);
          expect(criteria).toHaveLength(1);
          const cells = criteria[0]!.cells.filter((cell) => cell.environment === execution.environment);
          expect(cells).toHaveLength(1);
          expect(cells[0]!.gates).toContain(line.gate);
        }
      }
    }));

  it("holds no row, criterion, cell, or gate that no head execution's flag line put there", () =>
    hegel.test((tc) => {
      const { tagged, executions } = tc.draw(runGen);
      const { rows } = build(tagged, executions);
      for (const row of rows) {
        for (const criterion of row.criteria) {
          for (const cell of criterion.cells) {
            const gates = executions
              .filter((entry) => entry.world === undefined && entry.criterion === criterion.line - 1 && entry.environment === cell.environment)
              .flatMap((entry) => entry.evaluations.filter((line) => line.name === row.name && line.side === row.side).map((line) => line.gate));
            expect(gates.length).toBeGreaterThan(0);
            expect([...cell.gates].sort()).toEqual([...new Set(gates)].sort());
          }
        }
      }
      expect(new Set(rows.map((row) => JSON.stringify([row.name, row.side]))).size).toBe(rows.length);
    }));

  it("counts each criterion once, under its verdict only where a required cell of it stands on the side", () =>
    hegel.test((tc) => {
      const { tagged, executions } = tc.draw(runGen);
      const { table, rows } = build(tagged, executions);
      for (const row of rows) {
        const { held, proven, failed, unproven, moved, controls } = row.counts;
        expect(held + proven + failed + unproven + moved + controls).toBe(row.criteria.length);
        const required = row.criteria.filter((entry) => entry.cells.some((cell) => cell.role === "required"));
        expect(controls).toBe(row.criteria.length - required.length);
        for (const verdict of ["held", "proven", "failed", "unproven", "moved"] as const) {
          expect(row.counts[verdict]).toBe(required.filter((entry) => entry.verdict === verdict).length);
        }
        for (const criterion of row.criteria) {
          expect(criterion.verdict).toBe(table.rows.find((entry) => entry.line === criterion.line)!.verdict);
          // A green verdict counted on this side has its required cells
          // here passing: proof is never counted on a side where the
          // criterion only broke.
          if (criterion.cells.some((cell) => cell.role === "required") && (criterion.verdict === "held" || criterion.verdict === "proven")) {
            expect(criterion.cells.filter((cell) => cell.role === "required").every((cell) => cell.outcome === "pass")).toBe(true);
          }
        }
      }
    }));
});
