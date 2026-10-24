import { conditionTagText, HELD_TAG, readCriterionTags, roleIn, type CellRole, type Conditions } from "../condition/condition.js";
import type { RunRowVerdict, RunScenario, RunTable, RunTableCell, RunTableRow } from "../record/run-result.js";

// Responsibility: the verdict table (docs/spec.md "Verdicts"): from a run's
// executions, one cell per criterion and environment, and from the cells,
// one verdict per criterion, which the exit code follows. Also when a
// control cell needs another proof run. Boundary: pure. Running scenarios,
// and running them again for proof, is src/cli/run.ts's and
// src/run/run-concurrent.ts's.
//
// Only a Then proves. An execution whose first failure is a claim broken
// at a line in Then position is `fail` at that line; anything else that
// stopped it (a Given or When error, an undefined line, a claim nukadoko
// could not judge, a hook) is `broke`, and `broke` never proves, because a
// When that errors where the behaviour is absent says nothing about whether
// the Then can tell the difference.
//
// A control proves only with `--proof-runs` agreeing failures: the same
// Then line failing in each run of the cell. One failure could be the
// program being slow once, and proof is the one verdict that reads a
// failure as good news, so it is the one that needs the failure repeated.
// A required cell needs no proof runs: a failure there is red whether or
// not it repeats.

/** One execution, read for the table. */
export type ExecutionOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "fail" | "broke"; readonly line: number };

type Execution = Pick<RunScenario, "status" | "line" | "steps" | "hooks">;

/** What one execution came to. `inThen` says whether the step at an index
 * stands in Then position. Pure. */
export function executionOutcome(execution: Execution, inThen: (index: number) => boolean): ExecutionOutcome {
  if (execution.status === "passed") return { kind: "pass" };
  const index = execution.steps.findIndex((step) => step.status !== "passed" && step.status !== "skipped");
  if (index === -1) return { kind: "broke", line: execution.line };
  const step = execution.steps[index]!;
  const line = step.line ?? execution.line;
  const claimBroken = step.status === "failed" && step.error?.kind === "claim_broken" && inThen(index);
  return { kind: claimBroken ? "fail" : "broke", line };
}

function sameOutcome(a: ExecutionOutcome, b: ExecutionOutcome): boolean {
  if (a.kind === "pass" || b.kind === "pass") return a.kind === b.kind;
  return a.kind === b.kind && a.line === b.line;
}

/** A cell's executions folded: what every one came to when they agree,
 * `flaky` at the first one that did not pass when they do not. Pure. */
export function foldCell(outcomes: readonly ExecutionOutcome[]): Pick<RunTableCell, "outcome" | "line" | "runs"> {
  const first = outcomes[0];
  if (first === undefined) return { outcome: "not-run", runs: 0 };
  if (outcomes.every((outcome) => sameOutcome(outcome, first))) {
    return first.kind === "pass" ? { outcome: "pass", runs: outcomes.length } : { outcome: first.kind, line: first.line, runs: outcomes.length };
  }
  const failing = outcomes.find((outcome) => outcome.kind !== "pass") as Exclude<ExecutionOutcome, { kind: "pass" }>;
  return { outcome: "flaky", line: failing.line, runs: outcomes.length };
}

/** Whether a cell runs once more for proof: a control whose every run so
 * far failed at the same Then line, fewer than `proofRuns` times. A pass,
 * a `broke`, or a run that disagrees ends the proof runs. Pure. */
export function needsProofRun(role: CellRole, outcomes: readonly ExecutionOutcome[], proofRuns: number): boolean {
  const first = outcomes[0];
  if (role !== "control" || first === undefined || first.kind !== "fail") return false;
  return outcomes.length < proofRuns && outcomes.every((outcome) => sameOutcome(outcome, first));
}

/** Whether a cell is proof that its criterion tells the behaviour apart:
 * a control that failed at the same Then line in `proofRuns` runs or
 * more. Pure. */
export function proves(cell: Pick<RunTableCell, "role" | "outcome" | "runs">, proofRuns: number): boolean {
  return cell.role === "control" && cell.outcome === "fail" && cell.runs >= proofRuns;
}

function runsText(runs: number): string {
  return runs === 1 ? "1 run" : `${runs} runs`;
}

/** A row's verdict and the sentence that says why, from its cells. Red
 * only for a required cell that did not pass, or for a row with no
 * required cell at all, which nothing shows holds; a control never turns
 * a row red. Pure. */
export function judgeRow(cells: readonly RunTableCell[], proofRuns: number): { readonly verdict: RunRowVerdict; readonly reason: string } {
  const required = cells.filter((cell) => cell.role === "required");
  if (required.length === 0) {
    return { verdict: "failed", reason: "no environment of this run meets its conditions, so every cell is a control and nothing shows that it holds" };
  }
  const red = required.find((cell) => cell.outcome !== "pass");
  if (red !== undefined) {
    const where = `in ${red.environment}`;
    if (red.outcome === "not-run") return { verdict: "failed", reason: `did not run ${where}: ${red.reason ?? "no execution was recorded"}` };
    if (red.outcome === "fail") return { verdict: "failed", reason: `a claim broke at line ${red.line} ${where}` };
    if (red.outcome === "broke") return { verdict: "failed", reason: `stopped at line ${red.line} ${where} before a claim there was judged` };
    return { verdict: "failed", reason: `its ${runsText(red.runs)} ${where} disagree, the first that did not pass at line ${red.line}` };
  }
  const passedIn = required.map((cell) => cell.environment).join(", ");
  const proof = cells.find((cell) => proves(cell, proofRuns));
  if (proof !== undefined) {
    return {
      verdict: "proven",
      reason: `passes in ${passedIn}, and a claim broke at line ${proof.line} in ${proof.environment}, where its conditions do not hold, in each of ${runsText(proof.runs)}`,
    };
  }
  const controls = cells.filter((cell) => cell.role === "control");
  if (controls.length === 0) return { verdict: "held", reason: `passes in ${passedIn}` };
  return {
    verdict: "held",
    reason: `passes in ${passedIn}; no control shows a Then failing where its conditions do not hold (${controls.map((cell) => `${cell.environment}: ${cellText(cell)}`).join(", ")})`,
  };
}

/** A cell as the summary and a reason name it: `pass`, `fail@12`,
 * `broke@9`, `flaky@12`, or `·` when it did not run. Pure. */
export function cellText(cell: Pick<RunTableCell, "outcome" | "line">): string {
  if (cell.outcome === "not-run") return "·";
  if (cell.outcome === "pass") return "pass";
  return `${cell.outcome}@${cell.line}`;
}

/** One selected criterion: a pickle the run selected. */
export interface SelectedCriterion {
  readonly feature: string;
  readonly line: number;
  readonly name: string;
  /** Every tag the pickle carries. */
  readonly tags: readonly string[];
}

/** One environment of the run, with what it declares. */
export interface TableEnvironment {
  readonly name: string;
  readonly conditions: Conditions | undefined;
}

/** For each condition `tags` name, the value `declared` holds for it, or
 * `null` when it holds none: what a cell's role came from. Pure. */
export function conditionsOfCell(tags: readonly string[], declared: Conditions | undefined): Record<string, boolean | string | null> {
  const names = [...new Set(readCriterionTags(tags).conditions.map((tag) => tag.name))];
  return Object.fromEntries(names.map((name) => [name, declared !== undefined && Object.hasOwn(declared, name) ? declared[name]! : null]));
}

/** The role each cell of a criterion has, in the run's environments. */
export function rolesOf(tags: readonly string[], environments: readonly TableEnvironment[]): CellRole[] {
  const { conditions } = readCriterionTags(tags);
  return environments.map((environment) => roleIn(conditions, environment.conditions));
}

/** The condition tags and `@held` a criterion carries, as written. */
export function conditionTagsOf(tags: readonly string[]): string[] {
  const read = readCriterionTags(tags);
  return [...read.conditions.map(conditionTagText), ...(read.held ? [HELD_TAG] : [])];
}

export interface TableInput {
  readonly criteria: readonly SelectedCriterion[];
  readonly environments: readonly TableEnvironment[];
  /** Every execution of a cell, in the order it ran. */
  readonly outcomes: (feature: string, line: number, environment: string) => readonly ExecutionOutcome[];
  /** Why a cell with no execution did not run, when the run knows: the
   * program did not start for its world, or a BeforeAll failed. */
  readonly notRunReason: (environment: string) => string | undefined;
  readonly proofRuns: number;
}

/** The table: rows by feature path and line, cells in the run's
 * environment order. Pure. */
export function buildTable(input: TableInput): RunTable {
  const rows: RunTableRow[] = input.criteria.map((criterion) => {
    const roles = rolesOf(criterion.tags, input.environments);
    const cells: RunTableCell[] = input.environments.map((environment, index) => {
      const folded = foldCell(input.outcomes(criterion.feature, criterion.line, environment.name));
      return {
        world: "head",
        environment: environment.name,
        role: roles[index]!,
        conditions: conditionsOfCell(criterion.tags, environment.conditions),
        ...folded,
        ...(folded.outcome === "not-run" ? { reason: input.notRunReason(environment.name) ?? "no execution of it was recorded" } : {}),
      };
    });
    return {
      feature: criterion.feature,
      line: criterion.line,
      name: criterion.name,
      change: null,
      conditions: conditionTagsOf(criterion.tags),
      cells,
      ...judgeRow(cells, input.proofRuns),
    };
  });
  rows.sort((a, b) => (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0) || a.line - b.line);
  return {
    base: null,
    mapping_changed: null,
    worlds: input.environments.map((environment) => ({ world: "head", environment: environment.name })),
    rows,
  };
}
