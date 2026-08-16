// Responsibility: the scenario record shape from docs/spec.md "Running" /
// "The state directory" — one record per
// pickle, the scenario-level counterpart to a step's own step record
// (src/record/types.ts). `steps` mirrors the pickle's own step order; a
// step's `status` widens beyond a step record's ok/failed to also say *why*
// no step record exists for it (`skipped`/`undefined`/`ambiguous`) — the
// scenario record is what is allowed to say that, per docs/spec.md "an
// execution that never began must not be citable".
//
// `hooks` records compat's Before/After hooks' own outcome: they have no
// step record of their own since they run against the pickle's shared
// World, not any one step, so their own ok/failed outcome
// is recorded here instead, on the scenario record. Always present, even
// when empty (no compat hooks matched this pickle's tags, or none are
// registered at all) — same convention as `steps`.
//
// `ScenarioHookRecord.declared` is added now: a hook has no step record to
// carry its own `declared` field on (see
// src/record/types.ts's own header), so this record is where its own
// attachments/labels/links/parameters/logs land instead — one collector
// boundary per individual hook invocation, not per Before/After phase, so
// one hook's own declared data never gets smeared across its sibling hooks.
//
// `ScenarioHookRecord.error.kind` is added now: a hook has no step record of
// its own to carry `error.kind` on
// either (see src/record/types.ts's own header for the enum itself and why
// it exists), so this is where a hook's own failure gets the same machine-
// readable classification a step's own step record does — the M3 Allure
// emitter maps a hook to a fixture the same way it maps a step to a test
// result. Only four of the seven `ErrorKind` values are reachable here: a
// hook has no args/returns/binding concept of its own —
// only `timeout`, `unsupported` (done-callback arity, pending/skipped
// return), `world_invalid` (a declared World key's write, since a hook runs
// against the same World a compat step does), and `step_error`.
//
// `ScenarioHookRecord.type` gains `"after_step"`, and `.step_index` is added
// now: `AfterStep`
// (src/compat/hooks.ts) runs once per *executed* pickle step, not once per
// scenario the way Before/After do, so — unlike those two — its own record
// entry needs to say which step it ran after, or a report reading
// `record.hooks` would have no way to tell one AfterStep entry from another.
// `step_index` is present only when `type` is `"after_step"`; it is the
// 0-based index into this same record's own `steps` array (always the same
// index as into the pickle's own `steps`, since src/run/run-scenario.ts
// writes exactly one `steps` entry per pickle step, in order). A step this
// scenario skipped (an earlier step already failed) gets no AfterStep entry
// at all — it never executed, so there is no "after" for the hook to run at,
// the same "a step nothing matched doesn't appear here" convention this
// interface's own header already documents for a tag-mismatched hook.
//
// `ScenarioRecord.run_id` and `.git` are added now — recording-side
// groundwork for `nuka accept` (docs/spec.md
// "Sign-off"), which is not implemented yet and does not read either field
// itself. `run_id` identifies "every scenario record one `nuka run`
// invocation wrote" — a fact no existing field carries, since
// `scenario_record_id` is unique per pickle. `git` is the commit and cleanliness of the working
// tree "when the run started" (docs/spec.md "Sign-off" verbatim) — absent
// outside a git repository, before the first commit, or when the git call
// itself fails (src/run/probe-git.ts), the same fail-safe convention
// `target_version`'s probe already uses
// (src/environment/probe-version.ts): the run itself never fails over
// either field.
//
// `ScenarioHookRecord.trace`/`.actions`/`.truncated` close a gap: once the
// Playwright trace became one chunk per step, a Before/After/
// AfterStep hook's own `ctx.page()` calls stopped landing in any chunk at
// all, since a chunk only ever opened for a step's own boundary. A hook has
// no step record of its own (same "no args/returns/binding concept"
// reasoning as `.error.kind` above), so, like `.declared`, its own trace
// evidence lands here instead — one chunk per *individual* hook invocation
// (never one shared across every Before hook, say), read back into the same
// shape a step's own step record already carries (src/context/
// trace-actions.ts's `TraceEvidence`; src/record/types.ts's own
// `actions`/`truncated` doc comments explain the 100-entry cap and the
// five-key params allowlist — unchanged here, no separate convention).
// `trace` is present only when
// that invocation actually opened a chunk (touched `ctx.page()`/
// `this.openPage()`); `actions`/`truncated` follow the step record's own
// "present only when non-empty"/"present only when capped" rules. A hook
// has no `sections`/`polls` field, unlike a step's own step record: both
// come from `ctx.section`/`ctx.poll`, and a hook has no `ctx` of its own to
// call either from (only a World, `this`) — `actions`, read out of the
// trace chunk itself rather than from anything the hook explicitly called,
// is unaffected by that gap.
//
// `ScenarioRecord.browser` is added now — the
// measured counterpart to the new `config.browserType` (src/config/
// schema.ts), which lets a project launch firefox or webkit instead of
// chromium. It carries what the run actually launched (`Browser#
// browserType().name()`/`Browser#version()`), never the config value
// itself, and is absent for a scenario whose run never launched a browser
// at all — see the field's own doc comment for why.

import type { DeclaredSnapshot } from "../compat/declared.js";
import type { ActionEntry } from "../context/trace-actions.js";
import type { ErrorKind, ScreenshotEntry } from "../record/types.js";

export type ScenarioStepStatus = "passed" | "failed" | "skipped" | "undefined" | "ambiguous";

export interface ScenarioStepRecord {
  readonly text: string;
  readonly status: ScenarioStepStatus;
  /** The step's own step record id, or `null` when none was written
   * (`skipped`, `undefined`, `ambiguous`, or a Then-position mutates
   * rejection — all "never began" per docs/spec.md). */
  readonly step_record_id: string | null;
  /** Present whenever `status` is anything but `passed`/`skipped`: `skipped`
   * needs no explanation (it is a symptom of an earlier step's failure, not
   * its own), and `passed` has nothing to explain. */
  readonly error?: { readonly message: string };
}

/** One Before/After hook's own outcome — a hook that didn't apply to this
 * pickle (tag mismatch) is
 * simply absent, the same way a step nothing matched doesn't appear here
 * either. */
export interface ScenarioHookRecord {
  readonly type: "before" | "after" | "after_step";
  readonly status: "ok" | "failed";
  /** Present only when `status` is `"failed"`. `kind` is the same closed
   * enum a step's own step record `error.kind` uses (this file's own
   * header). */
  readonly error?: { readonly message: string; readonly kind: ErrorKind };
  /** This hook's own declared attachments/labels/links/parameters/logs —
   * same shape, same "collected at
   * collection time, never after" reasoning as a step's own `declared`
   * (src/record/types.ts). Present only when at least one of its own
   * sub-fields is non-empty. */
  readonly declared?: DeclaredSnapshot;
  /** Present only when `type` is `"after_step"` (this file's own header) —
   * the 0-based index into this
   * record's own `steps` array that this AfterStep hook ran after. */
  readonly step_index?: number;
  /** This hook invocation's own trace chunk, relative to the *scenario's*
   * evidence dir (this file's own header) —
   * unlike `ScenarioStepRecord`, a hook has no step record dir of its own,
   * so its chunk lands beside its sibling hooks' in the scenario's own dir
   * instead, each under a name unique to that one invocation (src/run/
   * run-scenario.ts's `hookChunkFileName`). Present only when this
   * invocation actually opened a chunk — a hook that never called
   * `ctx.page()`/`this.openPage()` carries no `trace` at all. */
  readonly trace?: string;
  /** Every Playwright call this hook invocation made through `ctx.page()`/
   * `this.openPage()`, read back out of its own trace chunk — same shape,
   * same 100-entry cap, same five-key params allowlist as a step's own
   * step record `actions` (src/record/types.ts's own header; this file's
   * own header). Present only when non-empty. */
  readonly actions?: readonly ActionEntry[];
  /** Present only when `actions` above hit its own 100-entry cap — same
   * `{ actions: <true total> }` shape as a step's own step record
   * `truncated` (src/record/types.ts). */
  readonly truncated?: { readonly actions: number };
}

export interface ScenarioEvidence {
  /** Scenario directory, relative to the project root (e.g.
   * ".nukadoko/records/scenarios/scn-..."). */
  readonly dir: string;
  /** Present only when a browser was used anywhere in the scenario. */
  readonly trace?: string;
  /** Screenshots actually written; empty when no browser was used. Same
   * shape as `EvidenceMeta.screenshots` (src/record/types.ts) — at most
   * one entry, `final.png`, with its own
   * `at`. */
  readonly screenshots: readonly ScreenshotEntry[];
}

export interface ScenarioRecord {
  readonly scenario_record_id: string;
  /** This run's own id — every
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
  /** The browser engine and version this scenario's run actually launched
   * — read from the real `Browser` object
   * (`Browser#browserType().name()` / `Browser#version()`), never from
   * `config.browserType` itself: a step can override the `page` fixture
   * with a browser this scenario's own `ctx` never launched, so only what
   * actually ran is trustworthy enough to record (docs/spec.md
   * "Declaration and measurement answer different questions"). Present only
   * when a browser was actually launched this scenario's run — a pickle
   * whose steps never destructure `page`/`context` opens none, and this key
   * is absent rather than naming a browser that never ran (the same
   * "no browser, no field" convention `evidence.trace` already follows). */
  readonly browser?: { readonly type: string; readonly version: string };
  readonly session: string | null;
  readonly started_at: string;
  readonly finished_at: string;
  readonly steps: readonly ScenarioStepRecord[];
  readonly hooks: readonly ScenarioHookRecord[];
  /** The commit and cleanliness of the working tree when this run started
   * (docs/spec.md "Sign-off": "the
   * commit the working tree was at when the run started"). Absent outside a
   * git repository, before the first commit, or when the git call fails —
   * see this file's own header. Measured once per run, not once per pickle:
   * every scenario record from the same `nuka run` invocation
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
  /** A `"scenario"`-scope fixture's own teardown failure — teardown runs
   * *after* every step's own step record for this
   * scenario is already written (src/record/types.ts's own header), so it
   * has nowhere else to land. Never changes `status` above: a broken
   * cleanup routine
   * must not turn an otherwise-passing scenario red for a reason unrelated
   * to its own acceptance criteria. Present only when non-empty; `nuka run`
   * still announces each entry on stderr (exit code unaffected) so it is
   * never silent even though it costs nothing here. A `"process"`-scope
   * fixture's own teardown failure — torn down once, after every scenario
   * in the invocation, not attributable to any single one — is reported the
   * same way, on stderr, but never lands on any one `ScenarioRecord`. */
  readonly teardown_errors?: readonly { readonly fixture: string; readonly message: string }[];
}
