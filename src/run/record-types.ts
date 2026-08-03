// Responsibility: the scenario record shape from docs/spec.md "Running" /
// "The state directory" (this task's spec, decision 6) — one record per
// pickle, the scenario-level counterpart to a step's receipt (receipt/
// types.ts). `steps` mirrors the pickle's own step order; a step's `status`
// widens beyond a receipt's ok/failed to also say *why* no receipt exists
// for it (`skipped`/`undefined`/`ambiguous`) — the scenario record is what is
// allowed to say that, per docs/spec.md "an execution that never began must
// not be citable".
//
// `hooks` is added now (m2b-compat-execution task spec, item 5): compat's
// Before/After hooks have no receipt of their own (they run against the
// pickle's shared World, not any one step), so their own ok/failed outcome
// is recorded here instead, on the scenario record. Always present, even
// when empty (no compat hooks matched this pickle's tags, or none are
// registered at all) — same convention as `steps`.
//
// `ScenarioHookRecord.declared` is added now (m2d-allure-shim task spec,
// item 4): a hook has no receipt to carry its own `declared` field on (see
// receipt/types.ts's own header), so this record is where its own
// attachments/labels/links/parameters/logs land instead — one collector
// boundary per individual hook invocation, not per Before/After phase, so
// one hook's own declared data never gets smeared across its sibling hooks.
//
// `ScenarioHookRecord.error.kind` is added now (m3a-receipt-kinds task spec,
// decision 2): a hook has no receipt of its own to carry `error.kind` on
// either (see receipt/types.ts's own header for the enum itself and why it
// exists), so this is where a hook's own failure gets the same machine-
// readable classification a step's receipt does — the M3 Allure emitter
// maps a hook to a fixture the same way it maps a step to a test result.
// Only four of the seven `ErrorKind` values are reachable here: a hook has
// no args/returns/binding concept of its own —
// only `timeout`, `unsupported` (done-callback arity, pending/skipped
// return), `world_invalid` (a declared World key's write, since a hook runs
// against the same World a compat step does), and `step_error`.
//
// `ScenarioRecord.run_id` and `.git` are added now (m4a-run-provenance task
// spec) — recording-side groundwork for `nuka accept` (docs/spec.md
// "Sign-off"), which is not implemented yet and does not read either field
// itself. `run_id` identifies "every scenario record one `nuka run`
// invocation wrote" — a fact no existing field carries, since `scenario_id`
// is unique per pickle. `git` is the commit and cleanliness of the working
// tree "when the run started" (docs/spec.md "Sign-off" verbatim) — absent
// outside a git repository, before the first commit, or when the git call
// itself fails (src/run/probe-git.ts), the same fail-safe convention
// `target_version`'s probe already uses
// (src/environment/probe-version.ts): the run itself never fails over
// either field.

import type { DeclaredSnapshot } from "../compat/declared.js";
import type { ErrorKind } from "../receipt/types.js";

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

/** One Before/After hook's own outcome (m2b-compat-execution task spec,
 * item 5) — a hook that didn't apply to this pickle (tag mismatch) is
 * simply absent, the same way a step nothing matched doesn't appear here
 * either. */
export interface ScenarioHookRecord {
  readonly type: "before" | "after";
  readonly status: "ok" | "failed";
  /** Present only when `status` is `"failed"`. `kind` is the same closed
   * enum a step's own `receipt.error.kind` uses (this file's own header). */
  readonly error?: { readonly message: string; readonly kind: ErrorKind };
  /** This hook's own declared attachments/labels/links/parameters/logs
   * (m2d-allure-shim task spec, item 4) — same shape, same "collected at
   * collection time, never after" reasoning as a step's own `declared`
   * (src/receipt/types.ts). Present only when at least one of its own
   * sub-fields is non-empty. */
  readonly declared?: DeclaredSnapshot;
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
  /** This run's own id (m4a-run-provenance task spec, decision 1) — every
   * scenario record one `nuka run` invocation writes shares the same value,
   * generated once per invocation, never per pickle. Required, unlike
   * `git` below: every run has one, regardless of git. */
  readonly run_id: string;
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
  readonly started_at: string;
  readonly finished_at: string;
  readonly steps: readonly ScenarioStepRecord[];
  readonly hooks: readonly ScenarioHookRecord[];
  /** The commit and cleanliness of the working tree when this run started
   * (m4a-run-provenance task spec, decision 2; docs/spec.md "Sign-off": "the
   * commit the working tree was at when the run started"). Absent outside a
   * git repository, before the first commit, or when the git call fails —
   * see this file's own header. Measured once per run, not once per pickle
   * (decision 4): every scenario record from the same `nuka run` invocation
   * carries the same value, even if a step during the run itself edits a
   * tracked file. */
  readonly git?: {
    /** Full 40-character sha. */
    readonly commit: string;
    /** No line other than a `#`-prefixed header appeared in `git status
     * --porcelain=v2 --branch`'s own output. */
    readonly clean: boolean;
  };
  readonly evidence: ScenarioEvidence;
}
