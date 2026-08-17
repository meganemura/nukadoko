import type {
  Background,
  Examples,
  GherkinDocument,
  Pickle,
  PickleStep,
  Scenario,
  Step,
  TableRow,
} from "@cucumber/messages";
import type { DeclaredSnapshot } from "../../compat/declared.js";
import type { ActionEntry } from "../../context/trace-actions.js";
import type { CallEntry, ErrorKind, PollRecord, StepRecord } from "../../record/types.js";
import type { ScenarioHookRecord, ScenarioRecord, ScenarioStepRecord } from "../../run/record-types.js";
import { contentTypeForFileName } from "../media-type.js";

// Responsibility: the pure transform at the center of this module, kept in
// one identifiable place — `mapStep` turns one pickle step's own record,
// step record, and gherkin context into one Allure *test* (not a child of one),
// `mapHooks` turns a scenario's own before/after hooks into fixtures, and
// `mapScenarioEvidence` turns whatever browser evidence belongs to the
// scenario as a whole into a synthetic fixture. No `allure-js-commons`
// import (not even a type-only one) and no `node:fs`: every input here is
// already resolved by a caller (emitter.ts reads/redacts step records itself and
// resolves the project name via identity.ts before calling any function in
// this file), so every function here can be driven entirely from fixture
// data in a test, with no real allure-results directory and no disk-
// touching allure-js runtime anywhere in the call graph. emitter.ts is the
// only place that turns the plain data these functions return into actual
// `ReporterRuntime` calls.
//
// **Step = test, not scenario = test.** This
// is the one thing to change to revert that choice later: `mapStep` is the
// function whose *output shape* ("this much data, this much status, these
// attachments — one unit") encodes it. Reverting to scenario = test means
// writing a new orchestrator that calls this same per-step data-gathering
// logic once per step but folds the results into one aggregate test instead
// of handing each to `emitter.ts`'s `emitStep` separately — the per-field
// logic (parameters, attachments, timelines, labels) does not need to
// change, only how many Allure tests the result becomes.
//
// **Why `mapStep` never fills in a `historyId`, and never will** (read this
// before "fixing" a step's own test that looks like it has no history): a
// step has no identity that survives a run. Text repeats (two steps can
// share the exact same wording), position shifts (an edit anywhere earlier
// in the feature file moves every line number after it), and occurrence
// count breaks under duplicate text the same way text itself does — every
// one of those was tried and each one produced a report that silently
// linked two *different* steps as if they were the same one, with no trace
// of the mistake left in the output to catch it later. Given that, the
// only choice that does not eventually lie is to make sure nothing links
// across runs at all: `mapStep`'s own `identityParameters` (three
// run/scenario/step-scoped values, `mode: "hidden"`) exist to force every
// step's own Allure test's own `historyId` apart, on purpose, every time.
// Do not replace them with `excluded: true` (Allure drops an `excluded`
// parameter from the hash entirely, which undoes the whole point) and do
// not delete them because the report "should" have history — it cannot,
// honestly, until steps carry an identity of their own, which nothing in
// this codebase invents.
//
// `mapScenario`, below, is a deliberately different case: a *scenario*, not
// a step, has content of its own to build a stable identity from — its own
// gherkin name, its own Examples row (when it has one), and its own ordered
// step text — none of which need position or an invented counter to stay
// meaningful across runs. `mapScenario`'s own `fullName` carries only the
// scenario's name (never a run id), and every one of its parameters that
// participates in `historyId` is deterministic from the scenario's own
// definition: two runs of the same scenario hash the same, and two
// Scenario Outline rows or two identically-named scenarios that actually
// differ hash apart. Only a scenario whose name, Examples row, and full
// ordered step text are *all* identical to another scenario's stays
// indistinguishable from it — the same "no link is safer than a wrong
// link" choice `mapStep` makes above, just one level up, where it can
// actually be satisfied most of the time instead of never.
//
// `@cucumber/messages` is fine to import here (types and the odd runtime
// value alike) — it is plain data with no I/O of its own, unlike the two
// things this module actually avoids.
//
// Owns the `[nukadoko.failure=<kind>]` marker format itself
// (`buildFailureMarker`) and the failed/broken split (`statusForKind`) —
// categories.ts imports both from here (not the other way around) precisely
// so this module never has to import categories.ts's own allure-js
// `Category`/`Status` values back.

export type MappedStatus = "passed" | "failed" | "broken" | "skipped";

export interface MappedLabel {
  readonly name: string;
  readonly value: string;
}

export interface MappedLink {
  readonly name?: string;
  readonly url: string;
  readonly type?: string;
}

export interface MappedParameter {
  readonly name: string;
  readonly value: string;
  readonly excluded?: boolean;
  /** `"hidden"` only — the one `ParameterMode` value this codebase ever
   * writes (verified against @allurereport/reader's own allure2 reader and
   * @allurereport/core's own historyId computation: a `mode: "hidden"`
   * parameter is hidden from the report's own UI but still folds into
   * `historyId`, unlike `excluded: true`, which drops out of the hash
   * entirely — this module's own header). A plain string
   * literal, not allure-js-commons' own `ParameterMode` enum import: that
   * type is itself already `"hidden" | "masked" | "default"`, a plain
   * string union, so this narrower field is directly assignable to it with
   * no cast needed at the one call site (emitter.ts) that hands these
   * straight to the SDK. */
  readonly mode?: "hidden";
}

/** A child step nested under a mapped step/hook (widened from a bare
 * `{ name }` shape) — a declared log line
 * (`mapDeclared`, always zero-width, `startMs === stopMs`, `"passed"`) or one
 * entry of a step's own `sections`/`polls` timeline (`mapTimelineChildSteps`,
 * below), which carry their own real duration and outcome. One shape for
 * both keeps `writeChildSteps` (emitter.ts) from needing to know which kind
 * of child step it is rendering. Nests directly under a step's own test now
 * — one level shallower than when a step was itself a child of the
 * scenario's own test. Verified this still works: parameters and errors are
 * still preserved, and the lost nesting level is carried by Allure's own
 * breadcrumb instead. */
export interface MappedChildStep {
  readonly name: string;
  readonly startMs: number;
  readonly stopMs: number;
  readonly status: MappedStatus;
  /** Present only on a call-derived child step (`mapCalls`, below) — a
   * part's own `args`/`result`, so they read without opening the
   * `record.json` attachment. Every other producer of a `MappedChildStep`
   * (declared logs, sections/polls/actions) leaves this unset. */
  readonly parameters?: readonly MappedParameter[];
  /** Always present on a call-derived child step (`mapCalls`, below,
   * recursing on `CallEntry.calls`) — `[]` for a call whose own part
   * called no part in turn, non-empty only when it did (docs/spec.md
   * "Parts": "a part that calls a part nests the same way"). Every other
   * producer of a `MappedChildStep` leaves this unset. */
  readonly childSteps?: readonly MappedChildStep[];
}

/** A file-path attachment names its *source* file (emitter.ts resolves it
 * against `rootDir` and lets allure-js-commons copy it); a buffer attachment
 * carries content this module already built in memory (`result`'s JSON) and
 * must be paired with an explicit `fileExtension` (verified against
 * allure-js-commons' own API: a Buffer attachment gets no extension from a
 * source path to infer one from). */
export type MappedAttachment =
  | { readonly kind: "path"; readonly name: string; readonly contentType: string; readonly path: string }
  | {
      readonly kind: "buffer";
      readonly name: string;
      readonly contentType: string;
      readonly content: string;
      readonly fileExtension: string;
    };

/** `type` stays the closed `"before" | "after"` pair unchanged even though
 * `record.hooks[].type`
 * itself now also has `"after_step"` — allure-js-commons' own `FixtureType`
 * is that exact same closed union (no third kind exists to map onto), and
 * the Allure side gets no new concept: an
 * `"after_step"` record hook still becomes an `"after"` fixture, just named
 * so its own step is readable from the report (`mapHooks`, below). Also
 * doubles as `mapScenarioEvidence`'s own synthetic "after" fixture shape —
 * same fields, same emitter.ts rendering path, no
 * second type needed for a fixture that happens not to come from a real
 * hook. */
export interface MappedHook {
  readonly type: "before" | "after";
  readonly name: string;
  readonly status: MappedStatus;
  readonly message?: string;
  readonly startMs: number;
  readonly stopMs: number;
  readonly attachments: MappedAttachment[];
  readonly childSteps: MappedChildStep[];
}

/** One step, mapped onto everything its own Allure test needs (step = test)
 * — the union of what used to be a step (a
 * child of the scenario's own test) and a test (the scenario's own test
 * itself), now the same thing. `featureName`/`description` exist per step
 * only because there is no longer a shared scenario-level test to hold them
 * once each — every step in one scenario computes the exact same value for
 * both, from the exact same gherkin document. */
export interface MappedStepTest {
  readonly name: string;
  readonly featureName: string;
  readonly description?: string;
  readonly status: MappedStatus;
  readonly message?: string;
  readonly startMs: number;
  readonly stopMs: number;
  readonly labels: MappedLabel[];
  readonly links: MappedLink[];
  readonly parameters: MappedParameter[];
  readonly attachments: MappedAttachment[];
  readonly childSteps: MappedChildStep[];
}

export interface MapStepInput {
  /** This run's own id — folded into
   * `identityParameters` below, never into
   * `fullName` (which stays a human-readable identifier: a run-specific
   * value must never be mixed into it). */
  readonly runId: string;
  /** This pickle's own scenario id (src/run/scenario-id.ts) — folded into
   * `identityParameters` below the same way `runId` is, so two scenarios
   * sharing one run (including two rows of one Scenario Outline, which
   * share one gherkin name) still get distinct identities. */
  readonly scenarioId: string;
  readonly environment: string;
  readonly session: string | null;
  readonly targetVersion?: string;
  readonly record: ScenarioStepRecord;
  /** The exact in-memory object `run-scenario.ts`'s own `writeStepRecord`
   * call
   * just persisted for this step, or `null` for a step with no step record
   * of its own at all (skipped, undefined, ambiguous, or a never-began
   * refusal) — never a step record that exists on disk but could not be
   * read
   * back: `pushStepRecord`'s own seam hands the caller
   * the object it already has, so there is nothing to re-read. */
  readonly stepRecord: StepRecord | null;
  /** This step's own 0-based position in both `record.steps` and
   * `pickle.steps` — folded into `identityParameters` below so two steps
   * sharing the exact same text in one scenario still get distinct
   * identities. */
  readonly index: number;
  /** The moment this step's own record was appended (run-scenario.ts's
   * `pushStepRecord`) — the zero-width anchor for a step with no step record
   * of its own, replacing the old "previous step's own stop" anchor a scenario-
   * level test's own child-step timeline used to need: with each step now
   * its own Allure test rather than one child among a scenario's own
   * timeline, there is no longer a parent test to stay ordered *within*. */
  readonly finishedAt: Date;
  readonly gherkinDocument: GherkinDocument;
  readonly pickle: Pickle;
  /** The feature file's root-relative path, already POSIX-normalized
   * (identity.ts's own `toPosixPath`) — used only for the `package` label
   * here (`fullName` itself is built by emitter.ts, which already has this
   * same value). */
  readonly posixPath: string;
}

// --- ErrorKind -> Allure status ---
//
// > failed = the system under test violated the contract. broken = the
// > contract layer failed to reach a verdict.
//
// Only `step_error` (the step's own code threw) and `result_invalid` (the
// return value itself violated the step's own schema) are the tested
// system's own fault; every other kind is the contract layer failing to
// reach a verdict at all.
const FAILED_KINDS: ReadonlySet<ErrorKind> = new Set(["step_error", "result_invalid"]);

export function statusForKind(kind: ErrorKind): "failed" | "broken" {
  return FAILED_KINDS.has(kind) ? "failed" : "broken";
}

/** The one place the `[nukadoko.failure=<kind>]` marker format is written
 * out — categories.ts's own regexes are built from this exact string too
 * (imported from here), so the marker this module writes into
 * `statusDetails.message` and the regex categories.json matches against can
 * never drift apart. */
export function buildFailureMarker(kind: ErrorKind): string {
  return `[nukadoko.failure=${kind}]`;
}

function markedMessage(kind: ErrorKind, message: string): string {
  return `${buildFailureMarker(kind)} ${message}`;
}

// --- gherkin document lookups (astNodeIds -> Scenario / Examples row) ---
// Verified against @cucumber/messages' own type definitions: a pickle's own
// `astNodeIds` always starts with its Scenario's id, and an outline row's
// `astNodeIds` also carries the matching Examples row's id — walking every
// scenario (through Rule children too) once builds both lookup maps this
// needs.

function collectScenarios(doc: GherkinDocument): Scenario[] {
  const scenarios: Scenario[] = [];
  for (const child of doc.feature?.children ?? []) {
    if (child.scenario) {
      scenarios.push(child.scenario);
    }
    for (const ruleChild of child.rule?.children ?? []) {
      if (ruleChild.scenario) {
        scenarios.push(ruleChild.scenario);
      }
    }
  }
  return scenarios;
}

function resolveScenario(doc: GherkinDocument, pickle: Pickle): Scenario | undefined {
  const byId = new Map(collectScenarios(doc).map((scenario) => [scenario.id, scenario] as const));
  for (const id of pickle.astNodeIds) {
    const found = byId.get(id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

// --- gherkin step id lookup (astNodeIds -> Step, for the keyword prefix
// mapStep below reads) — a separate walk from collectScenarios above,
// because a Background's own steps (feature-level or Rule-level) never
// appear as a Scenario, only their pickle steps do.

function collectGherkinSteps(doc: GherkinDocument): Map<string, Step> {
  const steps = new Map<string, Step>();
  const addBackground = (background: Background | undefined): void => {
    for (const step of background?.steps ?? []) {
      steps.set(step.id, step);
    }
  };
  const addScenario = (scenario: Scenario | undefined): void => {
    for (const step of scenario?.steps ?? []) {
      steps.set(step.id, step);
    }
  };
  for (const child of doc.feature?.children ?? []) {
    addBackground(child.background);
    addScenario(child.scenario);
    for (const ruleChild of child.rule?.children ?? []) {
      addBackground(ruleChild.background);
      addScenario(ruleChild.scenario);
    }
  }
  return steps;
}

/** The gherkin `keyword` (e.g. `"Given "`, trailing space included) for the
 * pickle step at `pickleSteps[index]`, or `undefined` when it can't be
 * resolved (index out of range, no astNodeIds, or the id isn't in
 * `stepIds` — `mapStep` falls back to the bare step text in that case). */
function resolveStepKeyword(
  stepIds: ReadonlyMap<string, Step>,
  pickleSteps: readonly PickleStep[],
  index: number,
): string | undefined {
  const astNodeId = pickleSteps[index]?.astNodeIds[0];
  return astNodeId !== undefined ? stepIds.get(astNodeId)?.keyword : undefined;
}

function resolveExampleRow(doc: GherkinDocument, pickle: Pickle): { examples: Examples; row: TableRow } | undefined {
  const byRowId = new Map<string, { examples: Examples; row: TableRow }>();
  for (const scenario of collectScenarios(doc)) {
    for (const examples of scenario.examples) {
      for (const row of examples.tableBody) {
        byRowId.set(row.id, { examples, row });
      }
    }
  }
  for (const id of pickle.astNodeIds) {
    const hit = byRowId.get(id);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

function resolveDescription(doc: GherkinDocument, scenario: Scenario | undefined): string | undefined {
  const scenarioDescription = scenario?.description.trim() ?? "";
  if (scenarioDescription !== "") {
    return scenarioDescription;
  }
  const featureDescription = doc.feature?.description.trim() ?? "";
  return featureDescription !== "" ? featureDescription : undefined;
}

/** Exported for `mapScenario`, below, to reuse verbatim — a Scenario
 * Outline row's own Examples values are the one already-verified way to
 * keep two rows of the same outline apart (this module's own header); a
 * second, hand-rolled copy of this lookup would only risk drifting from
 * the one `mapStep` already relies on for a step's own parameters. */
export function buildExampleParameters(doc: GherkinDocument, pickle: Pickle): MappedParameter[] {
  const hit = resolveExampleRow(doc, pickle);
  if (!hit) {
    return [];
  }
  const headers = hit.examples.tableHeader?.cells.map((cell) => cell.value) ?? [];
  const values = hit.row.cells.map((cell) => cell.value);
  return headers.map((name, index) => ({ name, value: values[index] ?? "" }));
}

// --- tags -> labels ---
// `@allure.label.<name>:<value>` / `@allure.label.<name>=<value>` resolve to
// a first-class label; `@allure.id:<v>` / `@allure.id=<v>` resolve to the
// `ALLURE_ID` label ("ALLURE_ID" is the literal string value allure-js-
// commons' own `LabelName.ALLURE_ID` enum member holds — spelled out here
// rather than importing the enum, since this module imports nothing from
// allure-js-commons). Anything else passes through as a raw `tag` label. A
// tag resolves to exactly one of the three, never more than one, so a
// resolved tag never also appearing as a raw `tag` label falls out of this
// loop for free rather than needing a second filtering
// pass.

const ALLURE_LABEL_TAG = /^@allure\.label\.([^:=]+)[:=](.+)$/;
const ALLURE_ID_TAG = /^@allure\.id[:=](.+)$/;

function resolveTagLabels(pickle: Pickle): MappedLabel[] {
  const labels: MappedLabel[] = [];
  for (const tag of pickle.tags) {
    const idMatch = ALLURE_ID_TAG.exec(tag.name);
    if (idMatch) {
      labels.push({ name: "ALLURE_ID", value: idMatch[1] ?? "" });
      continue;
    }
    const labelMatch = ALLURE_LABEL_TAG.exec(tag.name);
    if (labelMatch) {
      labels.push({ name: labelMatch[1] ?? "", value: labelMatch[2] ?? "" });
      continue;
    }
    labels.push({ name: "tag", value: tag.name });
  }
  return labels;
}

function dedupeLinks(links: readonly MappedLink[]): MappedLink[] {
  const seen = new Set<string>();
  const result: MappedLink[] = [];
  for (const link of links) {
    const key = JSON.stringify([link.url, link.name ?? null, link.type ?? null]);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(link);
    }
  }
  return result;
}

// --- declared attachments/logs/links/labels/parameters (shared by a step's
// own step record `declared` and a hook's own `record.hooks[].declared`, same
// shape either way) ---
//
// `contentTypeForFileName` (and the extension table backing it) lives in
// src/report/media-type.ts, shared with src/report/messages/map-scenario.ts.

function joinRelative(dir: string, fileName: string): string {
  return `${dir.replace(/\/+$/, "")}/${fileName}`;
}

interface MappedDeclared {
  readonly attachments: MappedAttachment[];
  readonly childSteps: MappedChildStep[];
  readonly links: MappedLink[];
  readonly labels: MappedLabel[];
  readonly parameters: MappedParameter[];
}

const EMPTY_DECLARED: MappedDeclared = { attachments: [], childSteps: [], links: [], labels: [], parameters: [] };

function mapDeclared(
  declared: DeclaredSnapshot | undefined,
  evidenceDir: string,
  timestampMs: number,
): MappedDeclared {
  if (!declared) {
    return EMPTY_DECLARED;
  }
  const attachments: MappedAttachment[] = (declared.attachments ?? []).map((fileName) => ({
    kind: "path",
    // The `declared: ` prefix is the entire provenance signal — after emit,
    // a measured and a declared attachment are otherwise indistinguishable.
    name: `declared: ${fileName}`,
    contentType: contentTypeForFileName(fileName),
    path: joinRelative(evidenceDir, fileName),
  }));
  // Zero-width at the caller's own `timestampMs` (the step's own start, or
  // the hook's own collapsed timestamp) and always `"passed"`.
  const childSteps: MappedChildStep[] = (declared.logs ?? []).map((text) => ({
    name: text,
    startMs: timestampMs,
    stopMs: timestampMs,
    status: "passed",
  }));
  const links: MappedLink[] = (declared.links ?? []).map((link) => ({
    url: link.url,
    name: link.name,
    type: link.type,
  }));
  const labels: MappedLabel[] = (declared.labels ?? []).map((label) => ({ name: label.name, value: label.value }));
  // `excluded` is deliberately never set here: allure only folds a *non*-
  // excluded parameter into historyId, so a declared parameter that reaches
  // the test unmarked genuinely changes which history bucket a scenario's
  // outcome lands in when its declared value differs run to run — the same
  // historyId behavior classic allure-cucumberjs has for its own step
  // parameters, carried through here rather than suppressed. (This is
  // already moot for a step's own test: every
  // step's own `identityParameters` already force `historyId` apart on
  // their own — a declared parameter's participation is unchanged, not the
  // thing doing the isolating.)
  const parameters: MappedParameter[] = (declared.parameters ?? []).map((parameter) => ({
    name: parameter.name,
    value: parameter.value,
  }));
  return { attachments, childSteps, links, labels, parameters };
}

// --- step / hook status resolution ---

interface Outcome {
  readonly status: MappedStatus;
  readonly message?: string;
  readonly kind?: ErrorKind;
}

/** `stepRecord` is exactly what the caller already has for this step —
 * never a
 * disk read (`MapStepInput.stepRecord`'s own doc
 * comment) — so, unlike the scenario = test design this replaced, there is
 * no longer an "unreadable record.json" case to fall back for: `stepRecord`
 * is `null` exactly when `step.step_record_id` is `null` (a step that never began
 * at all — skipped, undefined, ambiguous, or a never-began refusal). */
function resolveStepOutcome(step: ScenarioStepRecord, stepRecord: StepRecord | null): Outcome {
  if (step.status === "passed") {
    return { status: "passed" };
  }
  if (step.status === "skipped") {
    return { status: "skipped" };
  }
  if (step.status === "undefined" || step.status === "ambiguous") {
    // A vocabulary defect, not one of the `ErrorKind`s (there is no
    // step record to carry one) — broken, unmarked.
    return { status: "broken", message: step.error?.message };
  }
  // step.status === "failed"
  if (stepRecord && stepRecord.status === "failed") {
    const kind = stepRecord.error.kind;
    return { status: statusForKind(kind), message: markedMessage(kind, stepRecord.error.message), kind };
  }
  // A step that never began at all despite `status: "failed"` (a never-
  // began refusal, e.g. the read-only declared-mutates rejection) carries
  // no `kind` to classify with, so this falls back to the record's own
  // coarse status literally, using only what the record itself carries.
  return { status: "failed", message: step.error?.message };
}

function resolveHookOutcome(hook: ScenarioHookRecord): Outcome {
  if (hook.status === "ok") {
    return { status: "passed" };
  }
  if (!hook.error) {
    // Unreachable per record-types.ts's own contract (`error` is present
    // whenever `status` is `"failed"`) — defensive fallback only.
    return { status: "broken" };
  }
  const kind = hook.error.kind;
  return { status: statusForKind(kind), message: markedMessage(kind, hook.error.message), kind };
}

// --- sections + polls + actions -> one child-step timeline ---
//
// `PollRecord.outcome` -> `MappedStatus`: this is a different mapping than
// the existing `allureStatus` helper (emitter.ts) covers — that one goes
// `MappedStatus -> allure-js's own Status`, not `PollRecord["outcome"] ->
// MappedStatus` — so it cannot be reused here. `"resolved"` is what a poll's
// caller actually asked for, so `"passed"`. `"timed_out"` means the
// condition the step waited for was never met — the step is reporting its
// own contract failed to hold, the same "failed" a step's own kind-
// classified step record error gets, never "broken". `"failed"` means the
// poll's own `fn` threw, unrelated to whatever it was polling for — the
// contract layer failing to reach a verdict, "broken", the same bucket
// `statusForKind`'s own unclassified kinds fall into.
function pollOutcomeStatus(outcome: PollRecord["outcome"]): MappedStatus {
  switch (outcome) {
    case "resolved":
      return "passed";
    case "timed_out":
      return "failed";
    case "failed":
      return "broken";
  }
}

interface TimelineEntry {
  /** The original ISO 8601 string this entry's own `at` sorts by — kept
   * alongside the already-built `childStep` rather than re-derived from its
   * `startMs`, since a poll's own `startMs` is what `PollRecord.at` parses to
   * and comparing the source strings directly is simpler. */
  readonly at: string;
  readonly childStep: MappedChildStep;
}

/** `ActionEntry.outcome` -> `MappedStatus` — unlike `pollOutcomeStatus`
 * above, an action's own outcome is already binary (trace-actions.ts: the
 * trace's own `after` entry either carried an `error` or it didn't), so
 * there is no third "broken" bucket to reach for here: `"failed"` means the
 * Playwright call itself (an `expect` wait included) did not resolve the way
 * the step asked it to — the system under test violated the contract, the
 * same distinction the step record's own `error.kind` already draws — never the
 * contract layer failing to reach a verdict. */
function actionOutcomeStatus(outcome: ActionEntry["outcome"]): MappedStatus {
  return outcome === "failed" ? "failed" : "passed";
}

/** A readable name for one Playwright call — `ms` and `timeout_ms` are
 * deliberately never folded in here: `ms` is already visible as this child
 * step's own width (unlike a poll's `attempts`, which the width alone can't
 * reveal), and `timeout_ms` already lives in the `record.json` attachment.
 * `expect` needs its matcher and target named explicitly
 * (`before.params.expression`/`selector`) — neither is implied by `method`
 * alone, the way `goto`'s own target is implied by `url` — so it gets its
 * own branch; every other method falls back to `method` plus whichever of
 * `selector`/`url` the call happened to carry (e.g. `goto /orders`), or bare
 * `method` when neither was recorded. `is_not` (an `expect` call's own
 * `.not`) is folded into the matcher too — an unhandled negation would
 * render identically to its own opposite, which is exactly the silent-
 * misread this name exists to prevent. */
function actionName(action: ActionEntry): string {
  const target = action.selector ?? action.url;
  if (action.method === "expect" && action.expression !== undefined) {
    const matcher = action.is_not === true ? `not ${action.expression}` : action.expression;
    return target !== undefined ? `expect ${target} ${matcher}` : `expect ${matcher}`;
  }
  return target !== undefined ? `${action.method} ${target}` : action.method;
}

/** One step's own `sections`, `polls`, and `actions`, merged into one
 * child-step timeline in ascending `at` order — a section is a zero-width
 * marker at the moment `ctx.section` was called; a poll spans its own `at`
 * through `at + waited_ms`, its `attempts` folded into the name because that
 * count is the one fact only the name can carry here (`attempts: 1` means
 * the wait was a no-op; `40` means the opposite fix is needed, and duration
 * alone can't tell those apart); an action spans its own `at` through
 * `at + ms`, named by `actionName` above. Deliberately never clamped to the
 * parent step's own start/stop: a step record whose own timeline runs outside
 * its step's measured window is a real anomaly, not something to hide by
 * clipping it.
 *
 * Same-instant order, when `sections`/`polls`/`actions` land on the exact
 * same millisecond: sections, then polls, then actions, always — a fixed
 * choice made here once so a rerun of the same step record never reorders the
 * timeline and turns into an unreadable diff. Enforced by
 * `Array.prototype.sort`'s own stability: each category is pushed to
 * `entries` in that same order below, so two entries that tie on `at` keep
 * the order they were pushed in.
 *
 * A truncated `actions` array (`stepRecord.truncated.actions` present) gets one
 * more child step appended after the sort, naming the cut so a reader
 * scanning only the timeline never mistakes a capped list for the whole
 * story. Placed at the tail on purpose: it names a fact about the step record as
 * a whole, not a moment inside the step, so it is appended to the array
 * rather than merged into the `at`-ordered sort above.
 *
 * `source` is narrowed to just the four fields this function actually reads
 * rather than the full `StepRecord`, so `mapHooks` below can hand this the
 * exact same function a `ScenarioHookRecord` — which has `actions`/
 * `truncated` but no `sections`/`polls`/`started_at` of its own (a hook has
 * no `ctx` to call `ctx.section`/`ctx.poll` from) — without a second merge
 * function or a fake `StepRecord` shim. `fallbackAnchorMs` is whichever
 * timestamp is the right anchor for the caller (a step's own
 * `Date.parse(stepRecord.started_at)`, or a hook's own collapsed
 * `timestampMs`). */
function mapTimelineChildSteps(
  source: Pick<StepRecord, "sections" | "polls" | "actions" | "truncated">,
  fallbackAnchorMs: number,
): MappedChildStep[] {
  const entries: TimelineEntry[] = [];
  for (const section of source.sections ?? []) {
    const at = Date.parse(section.at);
    entries.push({ at: section.at, childStep: { name: section.label, startMs: at, stopMs: at, status: "passed" } });
  }
  for (const poll of source.polls ?? []) {
    const startMs = Date.parse(poll.at);
    entries.push({
      at: poll.at,
      childStep: {
        name: `${poll.description ?? "poll"} (${poll.attempts} attempts)`,
        startMs,
        stopMs: startMs + poll.waited_ms,
        status: pollOutcomeStatus(poll.outcome),
      },
    });
  }
  for (const action of source.actions ?? []) {
    const startMs = Date.parse(action.at);
    entries.push({
      at: action.at,
      childStep: {
        name: actionName(action),
        startMs,
        stopMs: startMs + action.ms,
        status: actionOutcomeStatus(action.outcome),
      },
    });
  }
  // `Array.prototype.sort` is stable, so two entries that share the exact
  // same instant keep the order they were pushed in above (sections, then
  // polls, then actions — this function's own doc comment).
  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const childSteps = entries.map((entry) => entry.childStep);

  if (source.truncated?.actions !== undefined) {
    const shownCount = source.actions?.length ?? 0;
    const notShownCount = source.truncated.actions - shownCount;
    // Anchored to the last real entry's own `stopMs` (falling back to
    // `fallbackAnchorMs` when the timeline is otherwise empty) so this
    // marker reads as "right after everything already shown" on both axes.
    const lastStopMs = childSteps.length > 0 ? childSteps[childSteps.length - 1]!.stopMs : fallbackAnchorMs;
    childSteps.push({
      name: `... ${notShownCount} more actions not shown`,
      startMs: lastStopMs,
      stopMs: lastStopMs,
      status: "passed",
    });
  }

  return childSteps;
}

/** `page_events`'s three categories as step parameters — visible without
 * opening the `record.json` attachment that already carries the same data
 * in full. A category with no entries is omitted, never shown as `0`. A
 * truncated category (`page_events.truncated.<category>` present) reports
 * the *true* total beside the shown count (`"100 of 4213"`) — the shown
 * count alone would understate what actually happened. */
function pageEventCount(entries: readonly unknown[] | undefined, truncatedTotal: number | undefined): string | undefined {
  if (!entries || entries.length === 0) {
    return undefined;
  }
  return truncatedTotal !== undefined ? `${entries.length} of ${truncatedTotal}` : String(entries.length);
}

// --- calls -> nested child steps ---
//
// A step's own `calls` (docs/spec.md "Parts") is kept as its own trailing
// group rather than merged into `mapTimelineChildSteps`'s own `at`-ordered
// sort above: a call's own span commonly overlaps the very actions/polls
// it caused (the call is the parent operation, they happen inside it), so
// a single flat timeline sorted by start time would interleave a part's
// own child steps with the calling step's, which is exactly the "depth
// under one line, not a second line" distinction docs/spec.md "Parts"
// draws. Nesting is the only shape that keeps that distinction visible.

/** One call's own args/result as step parameters — `args` is always
 * present (a call always carries the args it was given, docs/spec.md
 * "Parts"); `result` only when the call actually returned one (absent on
 * a call that failed, `CallEntry.result`'s own doc comment). Values are
 * JSON-stringified: a `Parameter`'s own `value` field is a plain string,
 * the same reason `stepRecordParameters` below turns every non-string
 * observed value into one with `String(...)`. */
function callParameters(entry: CallEntry): MappedParameter[] {
  const parameters: MappedParameter[] = [{ name: "args", value: JSON.stringify(entry.args) }];
  if (entry.result !== undefined) {
    parameters.push({ name: "result", value: JSON.stringify(entry.result) });
  }
  return parameters;
}

/** One step record's own `calls`, recursed into nested `MappedChildStep`s
 * — one per call, named after the part's own vocabulary name
 * (`CallEntry.step`), carrying its own args/result as parameters
 * (`callParameters`, above) and its own nested calls under `childSteps`
 * (`entry.calls`, docs/spec.md "Parts": "a part that calls a part nests
 * the same way"). A call's own failure is classified the same way a
 * step's own is (`statusForKind`, this module's own header) — a part's
 * `error` uses the same `ErrorKind` set a step record's own `error` does
 * (`CallEntry`'s own doc comment), so there is no second classification
 * to invent here. `undefined`/empty `calls` maps to `[]`, the same
 * "nothing to add" `mapTimelineChildSteps` already returns for an empty
 * timeline. */
function mapCalls(calls: readonly CallEntry[] | undefined): MappedChildStep[] {
  if (!calls || calls.length === 0) {
    return [];
  }
  return calls.map(
    (entry): MappedChildStep => ({
      name: entry.step,
      startMs: Date.parse(entry.started_at),
      stopMs: Date.parse(entry.finished_at),
      status: entry.error !== undefined ? statusForKind(entry.error.kind) : "passed",
      parameters: callParameters(entry),
      childSteps: mapCalls(entry.calls),
    }),
  );
}

// --- one step -> one Allure test ---

export function mapStep(input: MapStepInput): MappedStepTest {
  const {
    runId,
    scenarioId,
    environment,
    session,
    targetVersion,
    record,
    stepRecord,
    index,
    finishedAt,
    gherkinDocument,
    pickle,
    posixPath,
  } = input;

  const scenario = resolveScenario(gherkinDocument, pickle);
  const featureName = gherkinDocument.feature?.name ?? "";
  const stepIds = collectGherkinSteps(gherkinDocument);

  const outcome = resolveStepOutcome(record, stepRecord);

  let startMs: number;
  let stopMs: number;
  if (stepRecord) {
    startMs = Date.parse(stepRecord.started_at);
    stopMs = Date.parse(stepRecord.finished_at);
  } else {
    // A step with no step record (skipped/undefined/ambiguous, or a
    // never-began
    // refusal) has no time of its own to report — zero-width, anchored to
    // the moment this step's own record was appended (`MapStepInput.
    // finishedAt`'s own doc comment).
    const t = finishedAt.getTime();
    startMs = t;
    stopMs = t;
  }

  const stepRecordParameters: MappedParameter[] = [];
  const attachments: MappedAttachment[] = [];
  let declared: MappedDeclared = EMPTY_DECLARED;
  let timelineChildSteps: MappedChildStep[] = [];
  let callChildSteps: MappedChildStep[] = [];

  if (stepRecord) {
    // "step record id", not the bare "record" this parameter used to be
    // named: every other label here already says what it is measuring
    // (`mutates (declared)`, `http reads (observed)`) — a bare "record"
    // told a reader there was a record without saying which one.
    stepRecordParameters.push({ name: "step record id", value: stepRecord.step_record_id });
    stepRecordParameters.push({
      name: "mutates (declared)",
      value: stepRecord.mutates === null ? "not declared" : stepRecord.mutates ? "true" : "false",
    });
    stepRecordParameters.push({ name: "http reads (observed)", value: String(stepRecord.observed.http_reads) });
    stepRecordParameters.push({ name: "http writes (observed)", value: String(stepRecord.observed.http_writes) });
    if (stepRecord.world) {
      stepRecordParameters.push({ name: "world reads (observed)", value: stepRecord.world.reads.join(", ") });
      stepRecordParameters.push({ name: "world writes (observed)", value: stepRecord.world.writes.join(", ") });
    }
    if (stepRecord.used && stepRecord.used.length > 0) {
      stepRecordParameters.push({
        name: "used step records",
        value: stepRecord.used.map((entry) => entry.step_record_id).join(", "),
      });
    }
    if (stepRecord.required_env && stepRecord.required_env.length > 0) {
      stepRecordParameters.push({ name: "required env", value: stepRecord.required_env.join(", ") });
    }
    if (stepRecord.page_events) {
      const consoleErrors = pageEventCount(
        stepRecord.page_events.console_errors,
        stepRecord.page_events.truncated?.console_errors,
      );
      if (consoleErrors !== undefined) {
        stepRecordParameters.push({ name: "console errors (observed)", value: consoleErrors });
      }
      const pageErrors = pageEventCount(
        stepRecord.page_events.page_errors,
        stepRecord.page_events.truncated?.page_errors,
      );
      if (pageErrors !== undefined) {
        stepRecordParameters.push({ name: "page errors (observed)", value: pageErrors });
      }
      const failedRequests = pageEventCount(
        stepRecord.page_events.failed_requests,
        stepRecord.page_events.truncated?.failed_requests,
      );
      if (failedRequests !== undefined) {
        stepRecordParameters.push({ name: "failed requests (observed)", value: failedRequests });
      }
    }

    // The whole step record, verbatim, as one JSON attachment — every step
    // whose
    // step record exists, success or failure alike, never only the fields
    // this
    // module happens to map individually below. Already redacted before it
    // ever reached disk (write-step-record.ts's own callers), so no second
    // redaction pass belongs here.
    attachments.push({
      kind: "buffer",
      name: "record.json",
      contentType: "application/json",
      content: JSON.stringify(stepRecord, null, 2),
      fileExtension: ".json",
    });

    if (stepRecord.status === "ok" && stepRecord.result !== null) {
      attachments.push({
        kind: "buffer",
        name: "result",
        contentType: "application/json",
        content: JSON.stringify(stepRecord.result, null, 2),
        fileExtension: ".json",
      });
    }
    if (stepRecord.evidence.http) {
      attachments.push({
        kind: "path",
        name: "http log",
        contentType: "text/plain",
        path: joinRelative(stepRecord.evidence.dir, stepRecord.evidence.http),
      });
    }
    if (stepRecord.evidence.trace) {
      attachments.push({
        kind: "path",
        name: "trace",
        contentType: "application/vnd.allure.playwright-trace",
        path: joinRelative(stepRecord.evidence.dir, stepRecord.evidence.trace),
      });
    }
    // `screenshot.at` is never surfaced here — an attachment has no field to
    // put a timestamp on, so `file` (the only part Allure can place) is all
    // this mapping carries forward.
    for (const screenshot of stepRecord.evidence.screenshots) {
      attachments.push({
        kind: "path",
        name: screenshot.file,
        contentType: "image/png",
        path: joinRelative(stepRecord.evidence.dir, screenshot.file),
      });
    }
    // Application-specific evidence `evidence.attach`/`.path` produced —
    // same path-attachment shape as trace/screenshots above,
    // `name` kept as the step's own. `contentType` is guessed from `file`'s
    // own extension; an unrecognized extension falls back to
    // `application/octet-stream` rather than a guess this module cannot
    // verify.
    for (const attachment of stepRecord.evidence.attachments ?? []) {
      attachments.push({
        kind: "path",
        name: attachment.name,
        contentType: contentTypeForFileName(attachment.file),
        path: joinRelative(stepRecord.evidence.dir, attachment.file),
      });
    }

    declared = mapDeclared(stepRecord.declared, stepRecord.evidence.dir, startMs);
    attachments.push(...declared.attachments);
    timelineChildSteps = mapTimelineChildSteps(stepRecord, Date.parse(stepRecord.started_at));
    callChildSteps = mapCalls(stepRecord.calls);
  }

  // `record.steps[i]` mirrors `pickle.steps[i]` (record-types.ts's own
  // header) — the official cucumberjs allure adapter names a step
  // `"<keyword><text>"` (e.g. "Given a passed step"), and the gherkin
  // `keyword` itself already carries its own trailing space, so no
  // separator is added here. Falls back to the bare text when the keyword
  // can't be resolved.
  const keyword = resolveStepKeyword(stepIds, pickle.steps, index);
  const name = keyword !== undefined ? `${keyword}${record.text}` : record.text;

  // This test's own identity-breaking parameters — see this module's own
  // header for the full reasoning. `run`
  // alone already keeps two `nuka run` invocations apart; `scenario` keeps
  // two scenarios sharing one run apart (including two rows of one Scenario
  // Outline, which share one gherkin name); `step` keeps two steps sharing
  // the exact same text in one scenario apart. All three together, not any
  // one alone, are what make every emitted test's own `historyId` unique by
  // construction rather than by the accident of distinct step text.
  const identityParameters: MappedParameter[] = [
    { name: "nukadoko.run", value: runId, mode: "hidden" },
    { name: "nukadoko.scenario", value: scenarioId, mode: "hidden" },
    { name: "nukadoko.step", value: String(index), mode: "hidden" },
  ];

  const contextParameters: MappedParameter[] = [
    { name: "environment", value: environment, excluded: true },
    ...(session !== null ? [{ name: "session", value: session, excluded: true }] : []),
    ...(targetVersion !== undefined ? [{ name: "target_version", value: targetVersion, excluded: true }] : []),
  ];

  const labels: MappedLabel[] = [
    { name: "feature", value: featureName },
    { name: "package", value: posixPath.split("/").join(".") },
    ...resolveTagLabels(pickle),
    { name: "env", value: environment },
    ...declared.labels,
    // This step's own outcome, direct — no scenario-wide "first failure"
    // search needed any more: every failing
    // step now gets its own `nukadoko.failure` label and its own
    // `statusDetails.message`, on its own test, where the old scenario =
    // test design could only ever mark the first failure in the whole
    // scenario.
    ...(outcome.kind !== undefined ? [{ name: "nukadoko.failure", value: outcome.kind }] : []),
  ];

  return {
    name,
    featureName,
    description: resolveDescription(gherkinDocument, scenario),
    status: outcome.status,
    message: outcome.message,
    startMs,
    stopMs,
    labels,
    links: dedupeLinks(declared.links),
    parameters: [
      ...buildExampleParameters(gherkinDocument, pickle),
      ...stepRecordParameters,
      ...declared.parameters,
      ...contextParameters,
      ...identityParameters,
    ],
    attachments,
    // Declared log lines first (unchanged position and rendering), the
    // step's own sections/polls/actions timeline second, this step's own
    // `calls` last — additive, never reordering what was already there
    // (this section's own header explains why `calls` gets its own
    // trailing, nested group instead of folding into the `at`-ordered
    // timeline).
    childSteps: [...declared.childSteps, ...timelineChildSteps, ...callChildSteps],
  };
}

// --- one scenario -> one more Allure test, additive to its own steps' ---
//
// `mapScenario` runs once per scenario, at `endScenario` (emitter.ts), never
// once per step — it exists purely to give the whole scenario a second,
// stable identity to sit beside its own already-per-step tests (this
// module's own header explains why a step's own test can never have one).
// The result is a plain `MappedStepTest` again (same shape a step's own
// test already uses) rather than a new interface: emitter.ts already knows
// how to turn that shape into a `startTest`/`stopTest`/`writeTest` call, and
// a second, near-identical shape would only invite the two to drift.

export interface MapScenarioInput {
  readonly record: ScenarioRecord;
  readonly gherkinDocument: GherkinDocument;
  readonly pickle: Pickle;
  readonly environment: string;
  readonly session: string | null;
  readonly targetVersion?: string;
  /** The feature file's root-relative path, already POSIX-normalized — see
   * `MapStepInput.posixPath`'s own doc comment; the same value, computed
   * the same way, by the same caller. */
  readonly posixPath: string;
  /** The first of this scenario's own steps whose failure resolved to a
   * classified `ErrorKind` (mapStep's own `nukadoko.failure` label), or
   * `undefined` when no step's own failure was classified — a scenario that
   * passed, or one whose only failures were vocabulary defects (undefined/
   * ambiguous, which carry no `ErrorKind` at any grain). emitter.ts is the
   * only caller with the per-step visibility to compute this (it sees every
   * step's own mapped labels as they're emitted); `mapScenario` only
   * consumes it, here, to give the scenario-level test itself a category to
   * land in instead of Allure 3's built-in "Product errors" catch-all. */
  readonly firstFailure?: { readonly kind: string; readonly message: string };
}

/** `ScenarioStepRecord.status` (`"undefined"`/`"ambiguous"` included) onto
 * the four-way `MappedStatus` a child step can carry — the same "a
 * vocabulary defect is broken, unmarked" convention `resolveStepOutcome`
 * above already uses for a step's own test, applied here to the summary
 * child steps `mapScenario` lists below rather than reimplemented. */
function scenarioStepChildStatus(status: ScenarioStepRecord["status"]): MappedStatus {
  switch (status) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "undefined":
    case "ambiguous":
      return "broken";
  }
}

export function mapScenario(input: MapScenarioInput): MappedStepTest {
  const { record, gherkinDocument, pickle, environment, session, targetVersion, posixPath, firstFailure } = input;

  const scenario = resolveScenario(gherkinDocument, pickle);
  const featureName = gherkinDocument.feature?.name ?? "";

  const startMs = Date.parse(record.started_at);
  const stopMs = Date.parse(record.finished_at);

  // The one piece of this test's own identity `mapStep` has no equivalent
  // for: two scenarios can share a gherkin name (this module's own header),
  // and a shared name with no Examples row of its own (the Scenario
  // Outline case `buildExampleParameters` already covers) would otherwise
  // hash to the exact same `historyId`, wrongly folding the second one into
  // the first one's history. `record.steps[].text` is the pickle's own
  // already-interpolated step text (record-types.ts: "record.steps[i]
  // mirrors pickle.steps[i]"), so this reads the scenario's own content,
  // never anything about *this* run of it (unlike `mapStep`'s
  // `identityParameters`, this is deliberately not `runId`/`scenarioId`
  // scoped: the whole point here is for two runs of the same scenario to
  // agree). `status` is deliberately excluded from this join: a step's
  // outcome changing from one run to the next is exactly the "regressed"/
  // "fixed" transition this test exists to make visible, not a reason to
  // treat the two runs as different scenarios.
  const stepSignature = record.steps.map((step) => step.text).join("\n");

  const identityParameters: MappedParameter[] = [
    { name: "nukadoko.scenario.steps", value: stepSignature, mode: "hidden" },
  ];

  const contextParameters: MappedParameter[] = [
    { name: "environment", value: environment, excluded: true },
    ...(session !== null ? [{ name: "session", value: session, excluded: true }] : []),
    ...(targetVersion !== undefined ? [{ name: "target_version", value: targetVersion, excluded: true }] : []),
  ];

  const labels: MappedLabel[] = [
    { name: "feature", value: featureName },
    { name: "package", value: posixPath.split("/").join(".") },
    ...resolveTagLabels(pickle),
    { name: "env", value: environment },
    // Visible (unlike the identity parameters above), so a reader — or a
    // future tool — can tell this test apart from its own scenario's step
    // tests without relying on its own `name`'s "Scenario: " prefix alone.
    { name: "nukadoko.grain", value: "scenario" },
    // Reusing the first classified step failure's own kind (never
    // recomputed here — this module has no step record of its own to
    // classify from) is what keeps this test out of Allure 3's built-in
    // "Product errors" catch-all when the scenario failed for a reason one
    // of `nuka init`'s own seven categories already names.
    ...(firstFailure !== undefined ? [{ name: "nukadoko.failure", value: firstFailure.kind }] : []),
  ];

  const childSteps: MappedChildStep[] = record.steps.map((step) => ({
    name: step.text,
    startMs,
    stopMs,
    status: scenarioStepChildStatus(step.status),
  }));

  return {
    // "Scenario: " (never bare `pickle.name`) so this test's own leaf never
    // reads as plain, unlabeled duplicate text next to the "suite" tree
    // group heading its own `ensureSuiteLabels` call (emitter.ts) already
    // gives that exact name to — the leaf still names the scenario, just
    // not as the group heading's own bare echo. Never part of `fullName`
    // (built separately, in emitter.ts, from `pickle.name` alone) or of any
    // parameter, so this prefix changes nothing about `historyId`.
    name: `Scenario: ${pickle.name}`,
    featureName,
    description: resolveDescription(gherkinDocument, scenario),
    status: record.status,
    message: firstFailure?.message,
    startMs,
    stopMs,
    labels,
    links: [],
    parameters: [...buildExampleParameters(gherkinDocument, pickle), ...contextParameters, ...identityParameters],
    attachments: [],
    childSteps,
  };
}

// --- hooks -> fixtures (unchanged from
// before — hooks stay fixtures, mapped once the whole scenario is over) ---

interface HookMapping {
  readonly hook: MappedHook;
  /** A hook's own declared parameters (`this.attach`/`ctx.declare`-style
   * facade calls made from inside a Before/After body) land on that hook's
   * own fixture (`FixtureResult.parameters` — verified against allure-js-
   * commons' own model: a fixture carries the same `Executable` shape a
   * step or test does). A hook's own declared links and labels, unlike
   * parameters, have no home any more: the old scenario = test design
   * bubbled them onto the one scenario-wide test, but by the time a hook is
   * even mapped (scenario completion, well
   * after every step's own test is already written to disk),
   * there is no test left to reach, and a fixture has no `links`/`labels`
   * field in the Allure model at all to hold them instead. Dropped, not
   * silently miscounted: attachments and log lines a hook declares still
   * land on that hook's own fixture exactly as before (`hook.attachments`/
   * `hook.childSteps` below), unaffected. */
  readonly declaredParameters: MappedParameter[];
}

export function mapHooks(record: ScenarioRecord, scenarioStartMs: number, scenarioStopMs: number): HookMapping[] {
  return record.hooks.map((hook): HookMapping => {
    const outcome = resolveHookOutcome(hook);
    // record.json never carries a hook's own start/stop: every before-hook
    // collapses to the scenario's own `started_at`, every after-hook —
    // `"after"` and `"after_step"` alike — to its `finished_at`, both zero-
    // width. This is the same reason `hook.trace`'s own child-step timeline
    // below has no `started_at` of its own to anchor a truncation marker to
    // (mapTimelineChildSteps's own doc comment) — `timestampMs` is exactly
    // what a step's own `Date.parse(stepRecord.started_at)` would have been if
    // a hook had one.
    const timestampMs = hook.type === "before" ? scenarioStartMs : scenarioStopMs;
    const declared = mapDeclared(hook.declared, record.evidence.dir, timestampMs);
    // `"after_step"` folds onto Allure's own `"after"` fixture type; the
    // step it ran after is named into the fixture instead, since that is
    // the only place left for that fact to live without a new Allure-side
    // concept. `hook.step_index` is guaranteed present exactly when
    // `hook.type === "after_step"` (record-types.ts's own contract).
    const fixtureType: "before" | "after" = hook.type === "before" ? "before" : "after";
    const name =
      hook.type === "before" ? "Before" : hook.type === "after" ? "After" : `AfterStep[${hook.step_index}]`;
    // A hook invocation's own trace attachment and `actions` timeline,
    // mapped exactly the way a step's own step record `evidence.trace`/
    // `actions` already are (`mapStep`, above) — same contentType,
    // same `mapTimelineChildSteps` merge/truncation-marker function, no
    // separate rule for a hook. `hook.trace` is relative to the *scenario's*
    // own evidence dir, unlike a step's own step record `evidence.trace`,
    // which is
    // relative to that step's own step record dir — `joinRelative` takes
    // whichever dir actually matches its second argument.
    const attachments = [...declared.attachments];
    if (hook.trace) {
      attachments.push({
        kind: "path",
        name: "trace",
        contentType: "application/vnd.allure.playwright-trace",
        path: joinRelative(record.evidence.dir, hook.trace),
      });
    }
    const timelineChildSteps = mapTimelineChildSteps(hook, timestampMs);
    return {
      hook: {
        type: fixtureType,
        name,
        status: outcome.status,
        message: outcome.message,
        startMs: timestampMs,
        stopMs: timestampMs,
        attachments,
        // Declared log lines first (same order `mapStep` already uses for a
        // step's own declared.childSteps + timeline), the actions timeline
        // after.
        childSteps: [...declared.childSteps, ...timelineChildSteps],
      },
      declaredParameters: declared.parameters,
    };
  });
}

// --- scenario-level browser evidence -> a synthetic "after" fixture ---
//
// A browser's own final-state screenshot (`ScenarioRecord.evidence.
// screenshots` — in practice always at most one, `final.png`, taken once at
// `dispose()`) and the legacy `evidence.trace` field belong to the scenario
// as a whole, not any one step. The old scenario = test design attached
// both directly to the scenario's own test; there is no such test any more,
// and by the time this evidence is even
// known (`dispose()` runs after every step, so this is only ever called at
// scenario completion, the same `endScenario` moment `mapHooks` above is
// called from) every step's own test has already been written to disk —
// nothing can retroactively attach to one. A dedicated,
// clearly-named synthetic fixture keeps this evidence visible without
// folding it into a *real* hook's own fixture, which would misattribute
// where it actually came from.

export function mapScenarioEvidence(record: ScenarioRecord): MappedHook | undefined {
  const attachments: MappedAttachment[] = [];
  if (record.evidence.trace) {
    attachments.push({
      kind: "path",
      name: "trace",
      contentType: "application/vnd.allure.playwright-trace",
      path: joinRelative(record.evidence.dir, record.evidence.trace),
    });
  }
  for (const screenshot of record.evidence.screenshots) {
    attachments.push({
      kind: "path",
      name: screenshot.file,
      contentType: "image/png",
      path: joinRelative(record.evidence.dir, screenshot.file),
    });
  }
  // Never emit a synthetic thing with nothing to say (the same convention
  // `pageEventCount` above already follows for a page-events parameter).
  if (attachments.length === 0) {
    return undefined;
  }
  const stopMs = Date.parse(record.finished_at);
  return {
    type: "after",
    name: "Scenario evidence",
    status: "passed",
    startMs: stopMs,
    stopMs,
    attachments,
    childSteps: [],
  };
}
