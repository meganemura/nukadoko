import type { RunScenario, RunVerdict } from "../record/run-result.js";

// Responsibility: fold a run's scenario executions into one verdict per
// (scenario, environment), the cells run.json's `verdicts` holds and the
// run summary draws as a table. Boundary: pure.
//
// A cell is red when any execution in it is red: under `--repeat`, a
// scenario that failed once in an environment has not passed there, and
// `executions` and `passed` keep the count a reader needs.

type Execution = Pick<RunScenario, "feature" | "line" | "scenario" | "environment" | "status">;

/** One cell per scenario and environment that ran, features by path,
 * scenarios by line, and environments in the order the run was given. */
export function foldVerdicts(scenarios: readonly Execution[], environments: readonly string[]): RunVerdict[] {
  const cells = new Map<string, { -readonly [K in keyof RunVerdict]: RunVerdict[K] }>();
  for (const execution of scenarios) {
    const key = `${execution.feature}\u0000${execution.line}\u0000${execution.environment}`;
    const cell = cells.get(key) ?? {
      feature: execution.feature,
      line: execution.line,
      scenario: execution.scenario,
      environment: execution.environment,
      verdict: "passed" as const,
      executions: 0,
      passed: 0,
    };
    cell.executions += 1;
    if (execution.status === "passed") cell.passed += 1;
    else cell.verdict = "failed";
    cells.set(key, cell);
  }
  const order = (name: string): number => {
    const index = environments.indexOf(name);
    return index === -1 ? environments.length : index;
  };
  return [...cells.values()].sort(
    (a, b) =>
      (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0) ||
      a.line - b.line ||
      order(a.environment) - order(b.environment),
  );
}
