// Responsibility: the scenario record shape from docs/spec.md "Running" /
// "The state directory" (this task's spec, decision 6) — one record per
// pickle, the scenario-level counterpart to a step's receipt (receipt/
// types.ts). `steps` mirrors the pickle's own step order; a step's `status`
// widens beyond a receipt's ok/failed to also say *why* no receipt exists
// for it (`skipped`/`undefined`/`ambiguous`) — the scenario record is what is
// allowed to say that, per docs/spec.md "an execution that never began must
// not be citable".

export type ScenarioStepStatus = "passed" | "failed" | "skipped" | "undefined" | "ambiguous";

export interface ScenarioStepRecord {
  readonly text: string;
  readonly status: ScenarioStepStatus;
  /** The step's own receipt id, or `null` when none was written (`skipped`,
   * `undefined`, `ambiguous`, or a Then-position mutates rejection — all
   * "never began" per docs/spec.md). */
  readonly receipt: string | null;
  /** Present whenever `status` is anything but `passed`/`skipped`: `skipped`
   * needs no explanation (it is a symptom of an earlier step's failure, not
   * its own), and `passed` has nothing to explain. */
  readonly error?: { readonly message: string };
}

export interface ScenarioEvidence {
  /** Scenario directory, relative to the project root (e.g.
   * ".nukadoko/scenarios/scn-..."). */
  readonly dir: string;
  /** Present only when a browser was used anywhere in the scenario. */
  readonly trace?: string;
  /** Screenshot file names actually written; empty when no browser was used. */
  readonly screenshots: readonly string[];
}

export interface ScenarioRecord {
  readonly scenario_id: string;
  /** The feature file's path, relative to the project root. */
  readonly feature: string;
  /** The pickle's own name (Scenario Outline rows all share their outline's
   * name — gherkin's own convention, not something this record adds to). */
  readonly scenario: string;
  /** The pickle's gherkin `location.line` — the Scenario's own line, or an
   * Examples row's line for an expanded Scenario Outline. */
  readonly line: number;
  /** `passed` only when every step passed; any failed/skipped/undefined/
   * ambiguous step makes the whole scenario `failed`. */
  readonly status: "passed" | "failed";
  readonly environment: string;
  readonly target_version?: string;
  readonly session: string | null;
  readonly tag: string | null;
  readonly started_at: string;
  readonly finished_at: string;
  readonly steps: readonly ScenarioStepRecord[];
  readonly evidence: ScenarioEvidence;
}
