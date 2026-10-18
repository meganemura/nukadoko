import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { foldVerdicts } from "../src/run/verdicts.js";

// Responsibility: the fold from a run's scenario executions to run.json's
// `verdicts`, one cell per scenario and environment. The properties are
// what a reader of the summary relies on: a cell is red exactly when one of
// its executions is red, every execution lands in exactly one cell, and the
// run holds a red cell exactly when it holds a red execution, so the exit
// code and the cells can never disagree.

const ENVIRONMENTS = ["flag-on", "flag-off", "staging"] as const;

const execution = gs
  .tuples(
    gs.sampledFrom(["features/a.feature", "features/b.feature"]),
    gs.integers({ minValue: 1, maxValue: 4 }),
    gs.sampledFrom(ENVIRONMENTS),
    gs.sampledFrom(["passed", "failed"] as const),
  )
  .map(([feature, line, environment, status]) => ({ feature, line, scenario: `s${line}`, environment, status }));

const executions = gs.arrays(execution, { maxSize: 20 });

const keyOf = (entry: { feature: string; line: number; environment: string }): string =>
  `${entry.feature}:${entry.line}:${entry.environment}`;

describe("foldVerdicts", () => {
  it("makes a cell red if and only if some execution in it is red", () =>
    hegel.test((tc) => {
      const scenarios = tc.draw(executions);
      for (const cell of foldVerdicts(scenarios, [...ENVIRONMENTS])) {
        const inCell = scenarios.filter((entry) => keyOf(entry) === keyOf(cell));
        expect(cell.verdict === "failed").toBe(inCell.some((entry) => entry.status === "failed"));
        expect(cell.executions).toBe(inCell.length);
        expect(cell.passed).toBe(inCell.filter((entry) => entry.status === "passed").length);
      }
    }));

  it("gives one cell per distinct scenario and environment, and every execution to one cell", () =>
    hegel.test((tc) => {
      const scenarios = tc.draw(executions);
      const cells = foldVerdicts(scenarios, [...ENVIRONMENTS]);
      expect(cells.map(keyOf).sort()).toEqual([...new Set(scenarios.map(keyOf))].sort());
      expect(cells.reduce((total, cell) => total + cell.executions, 0)).toBe(scenarios.length);
    }));

  it("holds a red cell if and only if the run holds a red execution", () =>
    hegel.test((tc) => {
      const scenarios = tc.draw(executions);
      const cells = foldVerdicts(scenarios, [...ENVIRONMENTS]);
      expect(cells.some((cell) => cell.verdict === "failed")).toBe(scenarios.some((entry) => entry.status === "failed"));
    }));

  it("orders cells by feature, then line, then the order the environments were given", () => {
    const cells = foldVerdicts(
      [
        { feature: "features/b.feature", line: 2, scenario: "b", environment: "flag-on", status: "passed" },
        { feature: "features/a.feature", line: 7, scenario: "a7", environment: "flag-on", status: "passed" },
        { feature: "features/a.feature", line: 3, scenario: "a3", environment: "flag-on", status: "failed" },
        { feature: "features/a.feature", line: 3, scenario: "a3", environment: "flag-off", status: "passed" },
        { feature: "features/a.feature", line: 3, scenario: "a3", environment: "flag-off", status: "failed" },
      ],
      ["flag-off", "flag-on"],
    );
    expect(cells).toEqual([
      { feature: "features/a.feature", line: 3, scenario: "a3", environment: "flag-off", verdict: "failed", executions: 2, passed: 1 },
      { feature: "features/a.feature", line: 3, scenario: "a3", environment: "flag-on", verdict: "failed", executions: 1, passed: 0 },
      { feature: "features/a.feature", line: 7, scenario: "a7", environment: "flag-on", verdict: "passed", executions: 1, passed: 1 },
      { feature: "features/b.feature", line: 2, scenario: "b", environment: "flag-on", verdict: "passed", executions: 1, passed: 1 },
    ]);
  });
  it("gives every selected scenario a cell in every environment, not-run exactly when nothing ran there", () =>
    hegel.test((tc) => {
      const scenarios = tc.draw(executions);
      const selected = tc
        .draw(gs.arrays(gs.tuples(gs.sampledFrom(["features/a.feature", "features/b.feature"]), gs.integers({ minValue: 1, maxValue: 4 })), { maxSize: 8 }))
        .map(([feature, line]) => ({ feature, line, scenario: `s${line}` }));
      const cells = foldVerdicts(scenarios, [...ENVIRONMENTS], selected);
      const expected = new Set([...scenarios.map(keyOf), ...selected.flatMap((entry) => ENVIRONMENTS.map((environment) => keyOf({ ...entry, environment })))]);
      expect(cells.map(keyOf).sort()).toEqual([...expected].sort());
      for (const cell of cells) {
        const ran = scenarios.some((entry) => keyOf(entry) === keyOf(cell));
        expect(cell.verdict === "not-run").toBe(!ran);
        if (!ran) expect([cell.executions, cell.passed]).toEqual([0, 0]);
      }
    }));
});
