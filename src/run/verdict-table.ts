import { conditionTagText, describeConditions, HELD_TAG, readCriterionTags, roleIn, type CellRole, type Conditions } from "../condition/condition.js";
import type { Finding } from "../finding/finding.js";
import type { RunClaim, RunMappingChanges, RunRowChange, RunRowVerdict, RunScenario, RunTable, RunTableCell, RunTableRow, RunWorldName } from "../record/run-result.js";
import type { ClaimReadingValue } from "../record/types.js";
import { shellWord } from "../shell/shell-word.js";

// Responsibility: the verdict table (docs/spec.md "Verdicts"): from a run's
// executions, one cell per criterion, world, and environment, and from the
// cells, one verdict per criterion, which the exit code follows. Also which
// cells of the base and the old world a criterion needs, and when a cell
// needs another proof run. Boundary: pure. Running scenarios, in head's
// tree and in the trees of `nuka run --base`, and running them again for
// proof, is src/cli/run.ts's, src/run/run-concurrent.ts's, and
// src/run/tree-pass.ts's.
//
// Only a Then proves. An execution whose first failure is a claim broken
// at a line in Then position is `fail` at that line; anything else that
// stopped it (a Given or When error, an undefined line, a claim nukadoko
// could not judge, a hook) is `broke`, and `broke` never proves, because a
// When that errors where the behaviour is absent says nothing about whether
// the Then can tell the difference.
//
// A cell where the behaviour is absent (a head control, or a base cell)
// proves only with `--proof-runs` agreeing failures: the same claim (its
// position among its step's claims) breaking at the same Then line in each
// run of the cell. One failure could be the program being slow once, and
// proof is the one verdict that reads a failure as good news, so it is the
// one that needs the failure repeated. Two runs that broke two claims of
// one line failed for two reasons, so they disagree. The values need not
// agree: one that legitimately differs between runs, such as a generated
// id, would make every proof flaky. Each run's value is kept on the cell
// instead, for a reader to weigh. A required head cell and an old cell
// need no proof runs: a failure there is red whether or not it repeats.
//
// The worlds, and why each runs only some rows: head runs every row. The
// base world (the ref's code under head's criteria and mapping) runs a new
// or changed row, where it shows the behaviour is absent before the change;
// it is skipped when head already failed, or when a head control already
// proves the row, since nothing it shows could change the verdict. A row
// tagged `@held` always runs there, since `@held` says the base has the
// behaviour and only the base can show that. The old world (head's code
// under the ref's criteria and mapping) runs an unchanged row when the
// mapping changed and head passed, where it shows the approved sentence
// still means what it meant.

/** One execution, read for the table. A `fail` names the claim that broke,
 * by its position among its step's claims, and the actual value it saw. */
export type ExecutionOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "fail"; readonly line: number; readonly claim: number; readonly actual: ClaimReadingValue }
  | { readonly kind: "broke"; readonly line: number };

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
  const claims = step.claims ?? [];
  const claim = claims.findIndex((entry) => entry.outcome === "broken");
  // A claim_broken error names a broken claim by construction; without one
  // to point at, the run has no claim to agree on, so it cannot prove.
  if (!claimBroken || claim === -1) return { kind: "broke", line };
  return { kind: "fail", line, claim, actual: brokenActual(claims[claim]!) };
}

/** The actual value a broken claim saw, as run.json carries it: whole, as
 * the start of its JSON when run.json cut it, or why it had none. For a
 * claim over each item, the first broken item claim's. */
function brokenActual(claim: RunClaim): ClaimReadingValue {
  const comparison =
    "each" in claim
      ? claim.each.results.flatMap((item) => (item.selected && item.outcome === "broken" ? item.claims.filter((entry) => entry.outcome === "broken") : []))[0]
      : claim;
  if (comparison === undefined) return { reason: claim.reason ?? "no item claim broke" };
  const bytes = (comparison as { readonly actual_bytes?: number }).actual_bytes;
  if (bytes !== undefined) return { json_start: String(comparison.actual), json_bytes: bytes };
  if (Object.hasOwn(comparison, "actual")) return { value: comparison.actual };
  return { reason: comparison.reason ?? "the actual value held nothing" };
}

function sameOutcome(a: ExecutionOutcome, b: ExecutionOutcome): boolean {
  if (a.kind === "pass" || b.kind === "pass") return a.kind === b.kind;
  if (a.kind === "fail" && b.kind === "fail") return a.line === b.line && a.claim === b.claim;
  return a.kind === b.kind && a.line === b.line;
}

/** A cell's executions folded: what every one came to when they agree,
 * `flaky` at the first one that did not pass when they do not. A `fail`
 * keeps the claim every run broke and the actual value each run saw, in
 * run order. Pure. */
export function foldCell(outcomes: readonly ExecutionOutcome[]): Pick<RunTableCell, "outcome" | "line" | "runs" | "claim" | "actuals"> {
  const first = outcomes[0];
  if (first === undefined) return { outcome: "not-run", runs: 0 };
  if (outcomes.every((outcome) => sameOutcome(outcome, first))) {
    if (first.kind === "pass") return { outcome: "pass", runs: outcomes.length };
    if (first.kind === "broke") return { outcome: "broke", line: first.line, runs: outcomes.length };
    const actuals = outcomes.map((outcome) => (outcome as Extract<ExecutionOutcome, { kind: "fail" }>).actual);
    return { outcome: "fail", line: first.line, runs: outcomes.length, claim: first.claim, actuals };
  }
  const failing = outcomes.find((outcome) => outcome.kind !== "pass") as Exclude<ExecutionOutcome, { kind: "pass" }>;
  return { outcome: "flaky", line: failing.line, runs: outcomes.length };
}

/** Whether a cell stands where the criterion's behaviour is absent, so
 * that a Then failing there is proof: a head control, or a base cell. */
function absentHere(role: CellRole, world: RunWorldName): boolean {
  return world === "base" || (world === "head" && role === "control");
}

/** Whether a cell runs once more for proof: a head control or a base cell
 * whose every run so far broke the same claim at the same Then line, fewer
 * than `proofRuns` times. A pass, a `broke`, or a run that disagrees ends
 * the proof runs. Pure. */
export function needsProofRun(role: CellRole, outcomes: readonly ExecutionOutcome[], proofRuns: number, world: RunWorldName = "head"): boolean {
  const first = outcomes[0];
  if (!absentHere(role, world) || first === undefined || first.kind !== "fail") return false;
  return outcomes.length < proofRuns && outcomes.every((outcome) => sameOutcome(outcome, first));
}

/** Whether a cell is proof that its criterion tells the behaviour apart:
 * a head control or a base cell that broke the same claim at the same
 * Then line in `proofRuns` runs or more. Pure. */
export function proves(cell: Pick<RunTableCell, "role" | "outcome" | "runs"> & { readonly world?: RunWorldName }, proofRuns: number): boolean {
  return absentHere(cell.role, cell.world ?? "head") && cell.outcome === "fail" && cell.runs >= proofRuns;
}

function runsText(runs: number): string {
  return runs === 1 ? "1 run" : `${runs} runs`;
}

/** What `nuka run --base` knows of one criterion: how it compares with the
 * ref, whether it carries `@held`, and whether the mapping changed. */
export interface RowContext {
  readonly change: "unchanged" | "changed" | "new";
  readonly held: boolean;
  readonly mappingChanged: boolean;
}

/** The environments a row needs a base cell and an old cell in, from its
 * head cells (module header). `context` absent: a run without `--base`,
 * which has neither world. Pure. */
export function plannedWorldCells(
  headCells: readonly Pick<RunTableCell, "environment" | "role" | "outcome" | "runs">[],
  proofRuns: number,
  context: RowContext | undefined,
): { readonly base: readonly string[]; readonly old: readonly string[] } {
  const none = { base: [], old: [] };
  if (context === undefined) return none;
  const required = headCells.filter((cell) => cell.role === "required");
  if (required.length === 0 || required.some((cell) => cell.outcome !== "pass")) return none;
  const environments = required.map((cell) => cell.environment);
  if (context.change === "unchanged") return context.mappingChanged ? { base: [], old: environments } : none;
  if (!context.held && headCells.some((cell) => proves({ ...cell, world: "head" }, proofRuns))) return none;
  return { base: environments, old: [] };
}

function failedReason(red: RunTableCell): string {
  const where = `in ${red.environment}`;
  if (red.outcome === "not-run") return `did not run ${where}: ${red.reason ?? "no execution was recorded"}`;
  if (red.outcome === "fail") return `a claim broke at line ${red.line} ${where}`;
  if (red.outcome === "broke") return `stopped at line ${red.line} ${where} before a claim there was judged`;
  return `its ${runsText(red.runs)} ${where} disagree, the first that did not pass at line ${red.line}`;
}

// What a base or an old cell came to, as the clause of a reason that
// names it. An old cell's line is in the base's feature file, which the
// old world runs, so it says so.
function worldCellClause(cell: RunTableCell, proofRuns: number): string {
  const where = cell.world === "old" ? `in the old world in ${cell.environment}` : `at the base in ${cell.environment}`;
  const line = cell.world === "old" ? `line ${cell.line} of the base's feature file` : `line ${cell.line}`;
  if (cell.outcome === "not-run") return `it did not run ${where}: ${cell.reason ?? "no execution was recorded"}`;
  if (cell.outcome === "pass") return `it passed ${where}`;
  if (cell.outcome === "broke") return `it stopped at ${line} ${where} before a claim there was judged`;
  if (cell.outcome === "flaky") return `its ${runsText(cell.runs)} ${where} disagree, the first that did not pass at ${line}`;
  return cell.world === "base" && cell.runs < proofRuns
    ? `a claim broke at ${line} ${where} in only ${runsText(cell.runs)}, and proof needs ${proofRuns}`
    : `a claim broke at ${line} ${where}`;
}

function controlProofReason(passedIn: string, proof: RunTableCell): string {
  return `passes in ${passedIn}, and a claim broke at line ${proof.line} in ${proof.environment}, where its conditions do not hold, in each of ${runsText(proof.runs)}`;
}

/** A row's verdict and the sentence that says why, from its cells (module
 * header and docs/spec.md "Verdicts"). Red for a required head cell that
 * did not pass, or for a row with no required cell at all, which nothing
 * shows holds; under `--base`, red too for a new or changed row nothing
 * proves (`unproven`) and an unchanged row the old world does not pass
 * (`moved`). A control never turns a row red. Pure. */
export function judgeRow(
  cells: readonly RunTableCell[],
  proofRuns: number,
  context?: RowContext,
): { readonly verdict: RunRowVerdict; readonly reason: string } {
  const head = cells.filter((cell) => cell.world === "head");
  const required = head.filter((cell) => cell.role === "required");
  if (required.length === 0) {
    return { verdict: "failed", reason: "no environment of this run meets its conditions, so every cell is a control and nothing shows that it holds" };
  }
  const red = required.find((cell) => cell.outcome !== "pass");
  if (red !== undefined) return { verdict: "failed", reason: failedReason(red) };
  const passedIn = required.map((cell) => cell.environment).join(", ");
  const controls = head.filter((cell) => cell.role === "control");
  const controlProof = controls.find((cell) => proves(cell, proofRuns));

  if (context === undefined) {
    if (controlProof !== undefined) return { verdict: "proven", reason: controlProofReason(passedIn, controlProof) };
    if (controls.length === 0) return { verdict: "held", reason: `passes in ${passedIn}` };
    return {
      verdict: "held",
      reason: `passes in ${passedIn}; no control shows a Then failing where its conditions do not hold (${controls.map((cell) => `${cell.environment}: ${cellText(cell)}`).join(", ")})`,
    };
  }

  if (context.change === "unchanged") {
    if (!context.mappingChanged) return { verdict: "held", reason: `passes in ${passedIn}, and neither it nor the mapping changed since the base` };
    const old = cells.filter((cell) => cell.world === "old");
    const moved = old.find((cell) => cell.outcome !== "pass");
    if (old.length === 0) {
      return { verdict: "moved", reason: `passes in ${passedIn}, but the mapping changed since the base and the old world did not run it` };
    }
    if (moved !== undefined) {
      return { verdict: "moved", reason: `passes in ${passedIn}, but the mapping changed since the base, and ${worldCellClause(moved, proofRuns)}` };
    }
    return { verdict: "held", reason: `passes in ${passedIn}, and in the old world, where the base's mapping runs head's code` };
  }

  const base = cells.filter((cell) => cell.world === "base");
  const baseProof = base.find((cell) => proves(cell, proofRuns));
  if (baseProof !== undefined) {
    const proven = `passes in ${passedIn}, and a claim broke at line ${baseProof.line} at the base in ${baseProof.environment} in each of ${runsText(baseProof.runs)}`;
    return { verdict: "proven", reason: context.held ? `${proven}, so the base does not have this behaviour and @held is not needed` : proven };
  }
  if (controlProof !== undefined) return { verdict: "proven", reason: controlProofReason(passedIn, controlProof) };
  if (context.held) {
    if (base.length > 0 && base.every((cell) => cell.outcome === "pass")) {
      return { verdict: "held", reason: `passes in ${passedIn} and at the base, as @held says` };
    }
    const short = base.find((cell) => cell.outcome !== "pass");
    const clause = short === undefined ? "it did not run at the base" : worldCellClause(short, proofRuns);
    return { verdict: "unproven", reason: `passes in ${passedIn}, and @held says the base has this behaviour, but ${clause}` };
  }
  const absent = [
    ...base.map((cell) => `base ${cell.environment}: ${cellText(cell)}${cell.outcome === "not-run" && cell.reason !== undefined ? ` (${cell.reason})` : ""}`),
    ...controls.map((cell) => `control ${cell.environment}: ${cellText(cell)}`),
  ];
  return {
    verdict: "unproven",
    reason:
      absent.length === 0
        ? `passes in ${passedIn}, and no world where its behaviour is absent ran it, so nothing shows a Then failing without the change`
        : `passes in ${passedIn}, and nothing shows a Then failing where its behaviour is absent (${absent.join(", ")})`,
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

/** Whether a criterion has a required cell in one of `environments`:
 * one of them meets every condition its tags name. Pure. */
export function hasRequiredCell(tags: readonly string[], environments: readonly TableEnvironment[]): boolean {
  return rolesOf(tags, environments).includes("required");
}

/** The line the summary and stderr give the criteria a run left out under
 * `--env`, so the two say it in the same words. */
export function leftOutText(count: number): string {
  return count === 1
    ? "1 criterion not run: its conditions hold in no selected environment"
    : `${count} criteria not run: their conditions hold in no selected environment`;
}

/** A `criterion-without-required-cell` finding for each row with no
 * required cell, which only a run under `--no-check` reaches: the row is
 * red, and the table's reason alone gave no command. `elsewhere` names an
 * environment of the program file the run did not start that meets the
 * row's conditions, for a `do:` line that runs the scenario there; without
 * one, the `do:` line is `nuka check` on the file, which names the tags
 * and the environments as `condition-unmet`. Pure. */
export function rowsWithoutRequiredCell(
  table: Pick<RunTable, "rows">,
  environments: readonly TableEnvironment[],
  elsewhere: (tags: readonly string[]) => string | undefined,
): Finding[] {
  const described = environments.map((environment) => `${environment.name} (${describeConditions(environment.conditions)})`).join("; ");
  return table.rows.flatMap((row) => {
    if (row.cells.some((cell) => cell.role === "required")) return [];
    const { conditions } = readCriterionTags(row.conditions);
    const other = elsewhere(row.conditions);
    return [
      {
        severity: "failed",
        code: "criterion-without-required-cell",
        file: row.feature,
        line: row.line,
        message:
          `Scenario "${row.name}" needs ${conditions.map(conditionTagText).join(" ")}, and no environment of this run meets ${conditions.length === 1 ? "it" : "all of them"}: ${described}. ` +
          "Its cells are all controls, so nothing shows that it holds",
        do: (other === undefined ? ["nuka", "check", row.feature] : ["nuka", "run", `${row.feature}:${row.line}`, "--env", other]).map(shellWord).join(" "),
      },
    ];
  });
}

/** The condition tags and `@held` a criterion carries, as written. */
export function conditionTagsOf(tags: readonly string[]): string[] {
  const read = readCriterionTags(tags);
  return [...read.conditions.map(conditionTagText), ...(read.held ? [HELD_TAG] : [])];
}

/** A criterion the ref holds and head does not. */
export interface RemovedCriterion {
  readonly feature: string;
  readonly line: number;
  readonly name: string;
  /** Its condition tags and `@held`. */
  readonly tags: readonly string[];
  /** Its sentences at the ref. */
  readonly lines: readonly string[];
}

/** What `nuka run --base` compared, for the table. */
export interface TableBase {
  readonly ref: string;
  readonly commit: string;
  readonly mapping: RunMappingChanges;
  readonly mappingChanged: boolean;
  /** Each selected criterion's change, and where the ref holds it under
   * another name or file. */
  readonly changeOf: (feature: string, line: number) => { readonly change: "unchanged" | "changed" | "new"; readonly renamedFrom?: { readonly feature: string; readonly name: string } };
  readonly removed: readonly RemovedCriterion[];
}

export interface TableInput {
  readonly criteria: readonly SelectedCriterion[];
  readonly environments: readonly TableEnvironment[];
  /** Every execution of a cell, in the order it ran. A base or an old
   * cell is keyed by its row's head feature and line. */
  readonly outcomes: (feature: string, line: number, environment: string, world?: RunWorldName) => readonly ExecutionOutcome[];
  /** Why a cell with no execution did not run, when the run knows: the
   * program did not start for its world, or a BeforeAll failed. */
  readonly notRunReason: (environment: string, world?: RunWorldName) => string | undefined;
  readonly proofRuns: number;
  /** How many selected criteria the run left out, having no required cell
   * in an environment `--env` named. */
  readonly leftOut: number;
  /** Why a proof round could not record a control's run, when one could
   * not (src/run/run-concurrent.ts): the cell reads `broke` at the
   * scenario's line with that reason, whatever its earlier runs came to,
   * since a proof that could not finish proves nothing. */
  readonly proofProblem?: (feature: string, line: number, environment: string) => string | undefined;
  /** `undefined` for a run without `--base`. */
  readonly base?: TableBase;
}

const WORLD_ORDER: readonly RunWorldName[] = ["head", "base", "old"];

function byPlace(a: { readonly feature: string; readonly line: number }, b: { readonly feature: string; readonly line: number }): number {
  return (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0) || a.line - b.line;
}

/** The table: head's rows by feature path and line, then the removed
 * ones; columns head, base, old, each in the run's environment order, a
 * base or an old column only where some row has a cell. Pure. */
export function buildTable(input: TableInput): RunTable {
  // A base or an old cell names the conditions of head's environment it
  // stands under, as its role does: the row's roles are head's.
  const cellOf = (criterion: SelectedCriterion, environment: TableEnvironment, role: CellRole, world: RunWorldName): RunTableCell => {
    const folded = foldCell(input.outcomes(criterion.feature, criterion.line, environment.name, world));
    const problem = world === "head" && role === "control" ? input.proofProblem?.(criterion.feature, criterion.line, environment.name) : undefined;
    return {
      world,
      environment: environment.name,
      role,
      conditions: conditionsOfCell(criterion.tags, environment.conditions),
      ...(problem === undefined ? folded : { outcome: "broke" as const, line: criterion.line, runs: folded.runs, reason: problem }),
      ...(problem === undefined && folded.outcome === "not-run" ? { reason: input.notRunReason(environment.name, world) ?? "no execution of it was recorded" } : {}),
    };
  };
  const rows: RunTableRow[] = input.criteria.map((criterion) => {
    const roles = rolesOf(criterion.tags, input.environments);
    const headCells = input.environments.map((environment, index) => cellOf(criterion, environment, roles[index]!, "head"));
    const compared = input.base?.changeOf(criterion.feature, criterion.line);
    const context: RowContext | undefined =
      input.base === undefined || compared === undefined
        ? undefined
        : { change: compared.change, held: readCriterionTags(criterion.tags).held, mappingChanged: input.base.mappingChanged };
    const planned = plannedWorldCells(headCells, input.proofRuns, context);
    const roleIn = (environment: string): CellRole => headCells.find((cell) => cell.environment === environment)?.role ?? "required";
    const cells = [
      ...headCells,
      ...input.environments.filter((environment) => planned.base.includes(environment.name)).map((environment) => cellOf(criterion, environment, roleIn(environment.name), "base")),
      ...input.environments.filter((environment) => planned.old.includes(environment.name)).map((environment) => cellOf(criterion, environment, roleIn(environment.name), "old")),
    ];
    const change: RunRowChange | null = compared?.change ?? null;
    return {
      feature: criterion.feature,
      line: criterion.line,
      name: criterion.name,
      change,
      ...(compared?.renamedFrom === undefined ? {} : { renamed_from: compared.renamedFrom }),
      conditions: conditionTagsOf(criterion.tags),
      cells,
      ...judgeRow(cells, input.proofRuns, context),
    };
  });
  rows.sort(byPlace);
  const removed: RunTableRow[] = [...(input.base?.removed ?? [])].sort(byPlace).map((criterion) => ({
    feature: criterion.feature,
    line: criterion.line,
    name: criterion.name,
    change: "removed",
    conditions: conditionTagsOf(criterion.tags),
    cells: [],
    verdict: "removed",
    reason: "the base holds this criterion, and head no longer does",
    lines: criterion.lines,
  }));
  const worlds = WORLD_ORDER.flatMap((world) =>
    input.environments
      .filter((environment) => world === "head" || rows.some((row) => row.cells.some((cell) => cell.world === world && cell.environment === environment.name)))
      .map((environment) => ({ world, environment: environment.name })),
  );
  return {
    base: input.base === undefined ? null : { ref: input.base.ref, commit: input.base.commit },
    mapping_changed: input.base === undefined ? null : input.base.mappingChanged,
    mapping_changes: input.base === undefined ? null : input.base.mapping,
    worlds,
    rows: [...rows, ...removed],
    left_out: input.leftOut,
    proof_runs: input.proofRuns,
  };
}
