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
import type { ErrorKind, PollRecord, Receipt } from "../../receipt/types.js";
import type { ScenarioHookRecord, ScenarioRecord, ScenarioStepRecord } from "../../run/record-types.js";
import { contentTypeForFileName } from "../media-type.js";

// Responsibility: the pure transform at the center of this module
// (m3b-allure-emitter task spec, decision 2's own words: keeping
// map-scenario.ts a pure function is central to the whole design) —
// `(record, receipts, gherkin document,
// pickle, posixPath) -> flat description of what to attach where`. No
// `allure-js-commons` import (not even a type-only one) and no `node:fs`:
// every input here is already resolved by a caller (emitter.ts reads
// receipt.json files via read-receipt.ts and resolves the project name via
// identity.ts before calling this), so this module can be driven entirely
// from fixture data in a test, with no real allure-results directory and no
// disk-touching allure-js runtime anywhere in the call graph. emitter.ts is
// the only place that turns the plain data this returns into actual
// `ReporterRuntime` calls.
//
// `@cucumber/messages` is fine to import here (types and the odd runtime
// value alike) — it is plain data with no I/O of its own, unlike the two
// things this module actually avoids.
//
// Owns the `[nukadoko.failure=<kind>]` marker format itself
// (`buildFailureMarker`) and the failed/broken split (`statusForKind`) —
// categories.ts imports both from here (not the other way around) precisely
// so map-scenario.ts never has to import categories.ts's own allure-js
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
}

/** A child step nested under a mapped step/hook (p2-allure-measurement task
 * spec, decision: widened from `{ name }` alone) — a declared log line
 * (`mapDeclared`, always zero-width, `startMs === stopMs`, `"passed"`) or one
 * entry of a step's own `sections`/`polls` timeline (`mapTimelineChildSteps`,
 * below), which carry their own real duration and outcome. One shape for
 * both keeps `writeChildSteps` (emitter.ts) from needing to know which kind
 * of child step it is rendering. */
export interface MappedChildStep {
  readonly name: string;
  readonly startMs: number;
  readonly stopMs: number;
  readonly status: MappedStatus;
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

export interface MappedStep {
  readonly name: string;
  readonly status: MappedStatus;
  readonly message?: string;
  readonly startMs: number;
  readonly stopMs: number;
  readonly parameters: MappedParameter[];
  readonly attachments: MappedAttachment[];
  readonly childSteps: MappedChildStep[];
}

/** `type` stays the closed `"before" | "after"` pair unchanged (t7-compat-
 * status-afterstep task spec, item 2-6) even though `record.hooks[].type`
 * itself now also has `"after_step"` — allure-js-commons' own `FixtureType`
 * is that exact same closed union (no third kind exists to map onto), and
 * this task's spec is explicit that the Allure side gets no new concept: an
 * `"after_step"` record hook still becomes an `"after"` fixture, just named
 * so its own step is readable from the report (`mapHooks`, below). */
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

export interface MappedTest {
  readonly name: string;
  /** The Scenario's own gherkin name, unexpanded by any Examples row —
   * emitter.ts needs this (not the pickle's own possibly-expanded `name`)
   * to build the `fullName` variant `testCaseId` is computed from (this
   * task's spec, decision 5: every row of one Scenario Outline shares one
   * `testCaseId`). */
  readonly templateName: string;
  readonly description?: string;
  readonly featureName: string;
  readonly labels: MappedLabel[];
  readonly links: MappedLink[];
  readonly parameters: MappedParameter[];
  readonly startMs: number;
  readonly stopMs: number;
  readonly attachments: MappedAttachment[];
  /** The first failure's own (already `[nukadoko.failure=<kind>]`-marked, or
   * — when no kind resolved — plain) message, `undefined` when nothing
   * failed (M3-C spec item 1). emitter.ts sets this as `partialTest.
   * statusDetails.message`, the field Allure 2's own categories matching
   * (`extractErrorMatchingData`) reads at the test level — Allure 2 has no
   * other per-result category field, so the marker has to land here. Allure
   * 3 never reads this field at all: it categorizes the same failure by
   * matching a project-supplied config against the `nukadoko.failure`
   * label, which `labels` below carries out of this same `firstFailure`
   * search (docs/spec.md, "Allure emitter"). */
  readonly message?: string;
}

export interface MappedScenario {
  readonly test: MappedTest;
  readonly steps: MappedStep[];
  readonly hooks: MappedHook[];
}

export interface MapScenarioInput {
  readonly record: ScenarioRecord;
  /** Already-read receipts, keyed by receipt id — `null` for an id whose
   * receipt.json couldn't be read/parsed (this task's spec, decision 12:
   * treat an unreadable receipt as null and keep mapping). A step whose own
   * `record.steps[].receipt` isn't a key here at all is treated the same as
   * one mapped to `null`. */
  readonly receipts: ReadonlyMap<string, Receipt | null>;
  readonly gherkinDocument: GherkinDocument;
  readonly pickle: Pickle;
  /** The feature file's root-relative path, already POSIX-normalized
   * (identity.ts's own `toPosixPath`) — used only for the `package` label
   * here (`fullName` itself is built by emitter.ts, which already has this
   * same value). */
  readonly posixPath: string;
}

// --- ErrorKind -> Allure status (m3b-allure-emitter task spec, decision 3)
// ---
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
// mapSteps below reads) — a separate walk from collectScenarios above,
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
 * `stepIds` — mapSteps falls back to the bare step text in that case). */
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

function buildExampleParameters(doc: GherkinDocument, pickle: Pickle): MappedParameter[] {
  const hit = resolveExampleRow(doc, pickle);
  if (!hit) {
    return [];
  }
  const headers = hit.examples.tableHeader?.cells.map((cell) => cell.value) ?? [];
  const values = hit.row.cells.map((cell) => cell.value);
  return headers.map((name, index) => ({ name, value: values[index] ?? "" }));
}

// --- tags -> labels (this task's spec, decision 6) ---
// `@allure.label.<name>:<value>` / `@allure.label.<name>=<value>` resolve to
// a first-class label; `@allure.id:<v>` / `@allure.id=<v>` resolve to the
// `ALLURE_ID` label ("ALLURE_ID" is the literal string value allure-js-
// commons' own `LabelName.ALLURE_ID` enum member holds — spelled out here
// rather than importing the enum, since this module imports nothing from
// allure-js-commons). Anything else passes through as a raw `tag` label. A
// tag resolves to exactly one of the three, never more than one, so
// "resolved tags never also appear as a raw `tag` label" (this task's spec)
// falls out of this loop for free rather than needing a second filtering
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

// --- declared attachments/logs/links/labels (this task's spec, decisions
// 4, 6-7) — shared by both a step's own `receipt.declared` and a hook's own
// `record.hooks[].declared`, same shape either way. ---
//
// `contentTypeForFileName` (and the extension table backing it) now lives in
// src/report/media-type.ts (m3c-messages-emitter task spec, decision 2):
// src/report/messages/map-scenario.ts needs the identical lookup, so it was
// pulled up rather than becoming a third copy. Behavior here is unchanged —
// only the import moved.

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
    // The `declared: ` prefix is the entire provenance signal (this task's
    // spec, decision 7) — after emit, a measured and a declared attachment
    // are otherwise indistinguishable.
    name: `declared: ${fileName}`,
    contentType: contentTypeForFileName(fileName),
    path: joinRelative(evidenceDir, fileName),
  }));
  // Zero-width at the caller's own `timestampMs` (the step's own start, or
  // the hook's own collapsed timestamp) and always `"passed"` — the same
  // rendering `writeChildSteps` (emitter.ts) produced before `MappedChildStep`
  // grew `startMs`/`stopMs`/`status` (p2-allure-measurement task spec: a
  // declared log line's own behavior is not to change).
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
  // `excluded` is deliberately never set here (this task's spec, decision
  // 2): allure only folds a *non*-excluded parameter into historyId, so a
  // declared parameter that reaches the test unmarked genuinely changes
  // which history bucket a scenario's outcome lands in when its declared
  // value differs run to run — the same historyId behavior classic
  // allure-cucumberjs has for its own step parameters, carried through here
  // rather than suppressed.
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

function resolveStepOutcome(step: ScenarioStepRecord, receipts: ReadonlyMap<string, Receipt | null>): Outcome {
  if (step.status === "passed") {
    return { status: "passed" };
  }
  if (step.status === "skipped") {
    return { status: "skipped" };
  }
  if (step.status === "undefined" || step.status === "ambiguous") {
    // A vocabulary defect, not one of the `ErrorKind`s (there is no
    // receipt to carry one) — broken, unmarked (this task's spec, decision
    // 3).
    return { status: "broken", message: step.error?.message };
  }
  // step.status === "failed"
  const receipt = step.receipt !== null ? (receipts.get(step.receipt) ?? undefined) : undefined;
  if (receipt && receipt.status === "failed") {
    const kind = receipt.error.kind;
    return { status: statusForKind(kind), message: markedMessage(kind, receipt.error.message), kind };
  }
  // No usable receipt: either this step never began at all (e.g. a
  // declared-mutates-true step refused up front under a read-only
  // environment — src/run/run-scenario.ts's own "never began" family,
  // alongside undefined/ambiguous, but reported as `status: "failed"` there
  // rather than a status of its own) or its receipt.json exists but
  // couldn't be read. Neither carries a `kind` to classify with, so this
  // falls back to the record's own coarse status literally (this task's
  // spec, decision 12: report that step using only the status the record
  // itself carries) rather than guessing at a kind that was never actually
  // recorded.
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

// --- sections + polls -> one child-step timeline (p2-allure-measurement
// task spec, scope 2) ---
//
// `PollRecord.outcome` -> `MappedStatus`: this is a different mapping than
// the existing `allureStatus` helper (emitter.ts) covers — that one goes
// `MappedStatus -> allure-js's own Status`, not `PollRecord["outcome"] ->
// MappedStatus` — so it cannot be reused here; this is the "local table"
// this task's spec allows when the existing helper's own meaning doesn't
// fit. `"resolved"` is what a poll's caller actually asked for, so
// `"passed"`. `"timed_out"` means the condition the step waited for was
// never met — the step is reporting its own contract failed to hold, the
// same "failed" a step's own kind-classified receipt error gets, never
// "broken" (this task's spec: "期待した条件が満たされなかった"). `"failed"`
// means the poll's own `fn` threw, unrelated to whatever it was polling for
// — the contract layer failing to reach a verdict, "broken", the same
// bucket `statusForKind`'s own unclassified kinds fall into.
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
   * (verified in that field's own doc comment: "this poll's own start") and
   * comparing the source strings directly is what this task's spec asks for
   * ("両方 ISO 8601 なので比較は素直"). */
  readonly at: string;
  readonly childStep: MappedChildStep;
}

/** `ActionEntry.outcome` -> `MappedStatus` — unlike `pollOutcomeStatus`
 * above, an action's own outcome is already binary (trace-actions.ts: the
 * trace's own `after` entry either carried an `error` or it didn't), so
 * there is no third "broken" bucket to reach for here: `"failed"` means the
 * Playwright call itself (an `expect` wait included) did not resolve the way
 * the step asked it to, the same "the system under test violated the
 * contract" the receipt's own `error.kind` already distinguishes from
 * "the contract layer failed to reach a verdict" (this file's own header on
 * `FAILED_KINDS`) — an action's failure is always the former, never the
 * latter. */
function actionOutcomeStatus(outcome: ActionEntry["outcome"]): MappedStatus {
  return outcome === "failed" ? "failed" : "passed";
}

/** A readable name for one Playwright call (p3c-allure-actions task spec,
 * scope 1) — `ms` and `timeout_ms` are deliberately never folded in here:
 * `ms` is already visible as this child step's own width (unlike a poll's
 * `attempts`, which the width alone can't reveal), and `timeout_ms` already
 * lives in the `receipt.json` attachment. `expect` needs its matcher and
 * target named explicitly (`before.params.expression`/`selector`) — neither
 * is implied by `method` alone, the way `goto`'s own target is implied by
 * `url` — so it gets its own branch; every other method falls back to
 * `method` plus whichever of `selector`/`url` the call happened to carry
 * (e.g. `goto /orders`), or bare `method` when neither was recorded.
 * `is_not` (an `expect` call's own `.not`) is folded into the matcher too —
 * an unhandled negation would render identically to its own opposite, which
 * is exactly the silent-misread this name exists to prevent. */
function actionName(action: ActionEntry): string {
  const target = action.selector ?? action.url;
  if (action.method === "expect" && action.expression !== undefined) {
    const matcher = action.is_not === true ? `not ${action.expression}` : action.expression;
    return target !== undefined ? `expect ${target} ${matcher}` : `expect ${matcher}`;
  }
  return target !== undefined ? `${action.method} ${target}` : action.method;
}

/** One step's own `sections`, `polls`, and `actions`, merged into one
 * child-step timeline in ascending `at` order (p2-allure-measurement task
 * spec, scope 2; widened to include `actions` by p3c-allure-actions task
 * spec, scope 1) — a section is a zero-width marker at the moment
 * `ctx.section` was called; a poll spans its own `at` through
 * `at + waited_ms`, its `attempts` folded into the name because that count
 * is the one fact only the name can carry here (`attempts: 1` means the
 * wait was a no-op; `40` means the opposite fix is needed, and duration
 * alone can't tell those apart); an action spans its own `at` through
 * `at + ms`, named by `actionName` above. Deliberately never clamped to the
 * parent step's own start/stop: a receipt whose own timeline runs outside
 * its step's measured window is a real anomaly, not something to hide by
 * clipping it.
 *
 * Same-instant order, when `sections`/`polls`/`actions` land on the exact
 * same millisecond (p3c-allure-actions task spec, scope 3): sections, then
 * polls, then actions, always — a fixed choice (nothing about "what a
 * section/poll/action *is*" makes one belong before another at the same
 * instant) rather than a discovered one, made here once so a rerun of the
 * same receipt never reorders the timeline and turns into an unreadable
 * diff. Enforced by `Array.prototype.sort`'s own stability: each category is
 * pushed to `entries` in that same order below, so two entries that tie on
 * `at` keep the order they were pushed in.
 *
 * A truncated `actions` array (`receipt.truncated.actions` present) gets one
 * more child step appended after the sort, naming the cut so a reader
 * scanning only the timeline never mistakes a capped list for the whole
 * story (this task's spec, scope 2 — the same reason `page_events`'s own
 * `truncated` field exists, this file's own `pageEventCount` below). Placed
 * at the tail on purpose: it names a fact about the receipt as a whole, not
 * a moment inside the step, so it is appended to the array rather than
 * merged into the `at`-ordered sort above.
 *
 * `source` is narrowed to just the four fields this function actually reads
 * (p3d-hook-trace task spec) rather than the full `Receipt`, so `mapHooks`
 * below can hand this the exact same function a `ScenarioHookRecord` — which
 * has `actions`/`truncated` but no `sections`/`polls`/`started_at` of its
 * own (record-types.ts's own header explains why a hook has no `ctx` to call
 * `ctx.section`/`ctx.poll` from) — without a second merge function or a
 * fake `Receipt` shim. `fallbackAnchorMs` replaces the old direct read of
 * `receipt.started_at` for that same reason: a hook invocation has no
 * `started_at` of its own either, so the caller passes whichever timestamp
 * is the right anchor for it (a step's own `receipt.started_at`, or a
 * hook's own collapsed `timestampMs` — `mapHooks`' own doc comment on that
 * "documented limit"). */
function mapTimelineChildSteps(
  source: Pick<Receipt, "sections" | "polls" | "actions" | "truncated">,
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
    // `fallbackAnchorMs` when the timeline is otherwise empty, which cannot
    // happen in practice — `truncated.actions` is only ever present
    // alongside a full 100-entry `actions` array — but is not a type-level
    // guarantee `source` itself carries) so this marker reads as "right
    // after everything already shown" on both axes: last in the array
    // (`writeChildSteps`, emitter.ts, renders children in array order) and
    // latest in time.
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

/** `page_events`'s three categories as step parameters (p2-allure-measurement
 * task spec, scope 3) — visible without opening the `receipt.json` attachment
 * (scope 1) that already carries the same data in full. A category with no
 * entries is omitted, never shown as `0` (this task's spec). A truncated
 * category (`page_events.truncated.<category>` present) reports the *true*
 * total beside the shown count (`"100 of 4213"`) — the shown count alone
 * would understate what actually happened. */
function pageEventCount(entries: readonly unknown[] | undefined, truncatedTotal: number | undefined): string | undefined {
  if (!entries || entries.length === 0) {
    return undefined;
  }
  return truncatedTotal !== undefined ? `${entries.length} of ${truncatedTotal}` : String(entries.length);
}

// --- steps ---

interface StepMapping {
  readonly step: MappedStep;
  readonly declaredLinks: MappedLink[];
  readonly declaredLabels: MappedLabel[];
  readonly declaredParameters: MappedParameter[];
  readonly kind?: ErrorKind;
}

function mapSteps(
  record: ScenarioRecord,
  receipts: ReadonlyMap<string, Receipt | null>,
  scenarioStartMs: number,
  pickleSteps: readonly PickleStep[],
  stepIds: ReadonlyMap<string, Step>,
): StepMapping[] {
  let previousStopMs = scenarioStartMs;
  return record.steps.map((step, index): StepMapping => {
    const outcome = resolveStepOutcome(step, receipts);
    const receipt = step.receipt !== null ? (receipts.get(step.receipt) ?? undefined) : undefined;

    let startMs: number;
    let stopMs: number;
    if (receipt) {
      startMs = Date.parse(receipt.started_at);
      stopMs = Date.parse(receipt.finished_at);
    } else {
      // A step with no receipt (skipped/undefined/ambiguous, or a "never
      // began"/unreadable failure) has no time of its own to report — zero-
      // width, pinned to the previous step's own stop so it still lands in
      // the right place on the timeline (this task's spec, decision 8).
      startMs = previousStopMs;
      stopMs = previousStopMs;
    }
    previousStopMs = stopMs;

    const parameters: MappedParameter[] = [];
    const attachments: MappedAttachment[] = [];
    let declared: MappedDeclared = EMPTY_DECLARED;
    let timelineChildSteps: MappedChildStep[] = [];

    if (receipt) {
      parameters.push({ name: "receipt", value: receipt.receipt_id });
      parameters.push({
        name: "mutates (declared)",
        value: receipt.mutates === null ? "not declared" : receipt.mutates ? "true" : "false",
      });
      parameters.push({ name: "http reads (observed)", value: String(receipt.observed.http_reads) });
      parameters.push({ name: "http writes (observed)", value: String(receipt.observed.http_writes) });
      if (receipt.world) {
        parameters.push({ name: "world reads (observed)", value: receipt.world.reads.join(", ") });
        parameters.push({ name: "world writes (observed)", value: receipt.world.writes.join(", ") });
      }
      if (receipt.used && receipt.used.length > 0) {
        // `used`'s own entries widened to `{ receipt, step }` (m6a-from-core
        // task spec, item 5); this parameter's own rendering is unchanged —
        // still just the receipt ids, comma-joined — so this line only
        // updates the read to match the new shape.
        parameters.push({ name: "used receipts", value: receipt.used.map((entry) => entry.receipt).join(", ") });
      }
      if (receipt.required_env && receipt.required_env.length > 0) {
        parameters.push({ name: "required env", value: receipt.required_env.join(", ") });
      }
      if (receipt.page_events) {
        const consoleErrors = pageEventCount(
          receipt.page_events.console_errors,
          receipt.page_events.truncated?.console_errors,
        );
        if (consoleErrors !== undefined) {
          parameters.push({ name: "console errors (observed)", value: consoleErrors });
        }
        const pageErrors = pageEventCount(receipt.page_events.page_errors, receipt.page_events.truncated?.page_errors);
        if (pageErrors !== undefined) {
          parameters.push({ name: "page errors (observed)", value: pageErrors });
        }
        const failedRequests = pageEventCount(
          receipt.page_events.failed_requests,
          receipt.page_events.truncated?.failed_requests,
        );
        if (failedRequests !== undefined) {
          parameters.push({ name: "failed requests (observed)", value: failedRequests });
        }
      }

      // The whole receipt, verbatim, as one JSON attachment (p2-allure-
      // measurement task spec, scope 1) — every step whose receipt exists,
      // success or failure alike, never only the fields this module happens
      // to map individually below. Already redacted before it ever reached
      // disk (write-receipt.ts's own callers), so no second redaction pass
      // belongs here; this is the same object `readReceiptsForRecord`
      // (emitter.ts) read back. The point is durability against drift: a new
      // receipt field reaches this attachment automatically, with no emitter
      // change required, where the individually-mapped fields below need one
      // every time.
      attachments.push({
        kind: "buffer",
        name: "receipt.json",
        contentType: "application/json",
        content: JSON.stringify(receipt, null, 2),
        fileExtension: ".json",
      });

      if (receipt.status === "ok" && receipt.result !== null) {
        attachments.push({
          kind: "buffer",
          name: "result",
          contentType: "application/json",
          content: JSON.stringify(receipt.result, null, 2),
          fileExtension: ".json",
        });
      }
      if (receipt.evidence.http) {
        attachments.push({
          kind: "path",
          name: "http log",
          contentType: "text/plain",
          path: joinRelative(receipt.evidence.dir, receipt.evidence.http),
        });
      }
      if (receipt.evidence.trace) {
        attachments.push({
          kind: "path",
          name: "trace",
          contentType: "application/vnd.allure.playwright-trace",
          path: joinRelative(receipt.evidence.dir, receipt.evidence.trace),
        });
      }
      // `screenshot.at` is never surfaced here (fb4-evidence-time task spec,
      // scope: "at は Allure には出さない") — an attachment has no field to
      // put a timestamp on, so `file` (the only part Allure can place) is
      // all this mapping carries forward.
      for (const screenshot of receipt.evidence.screenshots) {
        attachments.push({
          kind: "path",
          name: screenshot.file,
          contentType: "image/png",
          path: joinRelative(receipt.evidence.dir, screenshot.file),
        });
      }

      declared = mapDeclared(receipt.declared, receipt.evidence.dir, startMs);
      attachments.push(...declared.attachments);
      timelineChildSteps = mapTimelineChildSteps(receipt, Date.parse(receipt.started_at));
    }

    // `record.steps[i]` mirrors `pickle.steps[i]` (record-types.ts's own
    // header) — the official cucumberjs allure adapter names a step
    // `"<keyword><text>"` (e.g. "Given a passed step"), and the gherkin
    // `keyword` itself already carries its own trailing space, so no
    // separator is added here. Falls back to the bare text when the
    // keyword can't be resolved (this task's spec, decision 1).
    const keyword = resolveStepKeyword(stepIds, pickleSteps, index);
    const name = keyword !== undefined ? `${keyword}${step.text}` : step.text;

    return {
      step: {
        name,
        status: outcome.status,
        message: outcome.message,
        startMs,
        stopMs,
        parameters,
        attachments,
        // Declared log lines first (unchanged position and rendering), the
        // step's own sections/polls timeline after (this task's spec, scope
        // 2) — additive, never reordering what was already there.
        childSteps: [...declared.childSteps, ...timelineChildSteps],
      },
      declaredLinks: declared.links,
      declaredLabels: declared.labels,
      declaredParameters: declared.parameters,
      kind: outcome.kind,
    };
  });
}

// --- hooks ---

interface HookMapping {
  readonly hook: MappedHook;
  readonly declaredLinks: MappedLink[];
  readonly declaredLabels: MappedLabel[];
  readonly declaredParameters: MappedParameter[];
  readonly kind?: ErrorKind;
}

function mapHooks(record: ScenarioRecord, scenarioStartMs: number, scenarioStopMs: number): HookMapping[] {
  return record.hooks.map((hook): HookMapping => {
    const outcome = resolveHookOutcome(hook);
    // record.json never carries a hook's own start/stop (documented limit,
    // restated on emitter.ts): every before-hook collapses to the
    // scenario's own `started_at`, every after-hook — `"after"` and
    // `"after_step"` alike (t7-compat-status-afterstep task spec) — to its
    // `finished_at`, both zero-width. This is the same reason `hook.trace`'s
    // own child-step timeline below has no `started_at` of its own to
    // anchor a truncation marker to (mapTimelineChildSteps's own doc
    // comment) — `timestampMs` is exactly what a step's own
    // `Date.parse(receipt.started_at)` would have been if a hook had one.
    const timestampMs = hook.type === "before" ? scenarioStartMs : scenarioStopMs;
    const declared = mapDeclared(hook.declared, record.evidence.dir, timestampMs);
    // `"after_step"` folds onto Allure's own `"after"` fixture type (this
    // task's spec, item 2-6 — see `MappedHook.type`'s own comment for why);
    // the step it ran after is named into the fixture instead, since that is
    // the only place left for that fact to live without a new Allure-side
    // concept. `hook.step_index` is guaranteed present exactly when
    // `hook.type === "after_step"` (record-types.ts's own contract).
    const fixtureType: "before" | "after" = hook.type === "before" ? "before" : "after";
    const name =
      hook.type === "before" ? "Before" : hook.type === "after" ? "After" : `AfterStep[${hook.step_index}]`;
    // p3d-hook-trace task spec: a hook invocation's own trace attachment and
    // `actions` timeline, mapped exactly the way a step's own
    // `receipt.evidence.trace`/`receipt.actions` already are (`mapSteps`,
    // above) — same contentType, same `mapTimelineChildSteps` merge/
    // truncation-marker function, no separate rule for a hook. `hook.trace`
    // is relative to the *scenario's* own evidence dir (record-types.ts's
    // own header), unlike a step's `receipt.evidence.trace`, which is
    // relative to that step's own receipt dir — `joinRelative` takes
    // whichever dir actually matches its second argument, so this only
    // changes which dir is passed in, not how the path is built.
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
        // Declared log lines first (same order `mapSteps` already uses for
        // a step's own declared.childSteps + timeline), the actions
        // timeline after.
        childSteps: [...declared.childSteps, ...timelineChildSteps],
      },
      declaredLinks: declared.links,
      declaredLabels: declared.labels,
      declaredParameters: declared.parameters,
      kind: outcome.kind,
    };
  });
}

// --- first failure in execution order (before hooks -> steps -> after
// hooks), this task's spec, decision 4, extended by M3-C spec item 1: one
// search now returns both the `nukadoko.failure` label's kind *and* that
// same failure's already-marked message, so the two can never drift apart
// (the alternative — searching twice, once for kind and once for message —
// risks picking a different failure for each if the two searches were ever
// edited independently). `kind` is `undefined` both when nothing failed and
// when the first failure has no resolvable kind (the same "never began"/
// unreadable-receipt edge case `resolveStepOutcome` already falls back for)
// — the search stops at the first failure either way rather than skipping
// ahead to a later one that happens to have a kind, since the label's own
// meaning is "the first failure's kind", not "the first classifiable
// failure's kind". `message`, unlike `kind`, is populated even when `kind`
// isn't: `resolveStepOutcome`'s own unmarked fallback (`step.error?.message`)
// already flows into `entry.step.message`/`entry.hook.message` regardless of
// whether a kind was resolved, so this function only has to forward
// whichever of the two is already there (M3-C spec item 1: if there is a
// message, include it).

interface FirstFailure {
  readonly kind?: ErrorKind;
  readonly message?: string;
}

function firstFailure(
  beforeHooks: readonly HookMapping[],
  steps: readonly StepMapping[],
  afterHooks: readonly HookMapping[],
): FirstFailure | undefined {
  for (const entry of beforeHooks) {
    if (entry.hook.status !== "passed") {
      return { kind: entry.kind, message: entry.hook.message };
    }
  }
  for (const entry of steps) {
    if (entry.step.status !== "passed" && entry.step.status !== "skipped") {
      return { kind: entry.kind, message: entry.step.message };
    }
  }
  for (const entry of afterHooks) {
    if (entry.hook.status !== "passed") {
      return { kind: entry.kind, message: entry.hook.message };
    }
  }
  return undefined;
}

export function mapScenario(input: MapScenarioInput): MappedScenario {
  const { record, receipts, gherkinDocument, pickle, posixPath } = input;
  const scenario = resolveScenario(gherkinDocument, pickle);
  const featureName = gherkinDocument.feature?.name ?? "";

  const scenarioStartMs = Date.parse(record.started_at);
  const scenarioStopMs = Date.parse(record.finished_at);

  const stepIds = collectGherkinSteps(gherkinDocument);
  const stepMappings = mapSteps(record, receipts, scenarioStartMs, pickle.steps, stepIds);
  const hookMappings = mapHooks(record, scenarioStartMs, scenarioStopMs);
  const beforeHookMappings = hookMappings.filter((entry) => entry.hook.type === "before");
  const afterHookMappings = hookMappings.filter((entry) => entry.hook.type === "after");

  const declaredLinks = dedupeLinks([
    ...stepMappings.flatMap((entry) => entry.declaredLinks),
    ...hookMappings.flatMap((entry) => entry.declaredLinks),
  ]);
  const declaredLabels: MappedLabel[] = [
    ...stepMappings.flatMap((entry) => entry.declaredLabels),
    ...hookMappings.flatMap((entry) => entry.declaredLabels),
  ];
  // Collected from both steps and hooks, same as declaredLinks/declaredLabels
  // above (this task's spec, decision 2) — the facade's `parameter()` is a
  // test-result-level call, so unlike `declared.attachments` (which stays
  // pinned to the step/hook that recorded it) there is no narrower home for
  // these than the test itself.
  const declaredParameters: MappedParameter[] = [
    ...stepMappings.flatMap((entry) => entry.declaredParameters),
    ...hookMappings.flatMap((entry) => entry.declaredParameters),
  ];

  const failure = firstFailure(beforeHookMappings, stepMappings, afterHookMappings);

  const labels: MappedLabel[] = [
    { name: "feature", value: featureName },
    { name: "package", value: posixPath.split("/").join(".") },
    ...resolveTagLabels(pickle),
    { name: "env", value: record.environment },
    ...declaredLabels,
    ...(failure?.kind ? [{ name: "nukadoko.failure", value: failure.kind }] : []),
  ];

  const contextParameters: MappedParameter[] = [
    { name: "environment", value: record.environment, excluded: true },
    ...(record.session !== null ? [{ name: "session", value: record.session, excluded: true }] : []),
    ...(record.target_version !== undefined
      ? [{ name: "target_version", value: record.target_version, excluded: true }]
      : []),
  ];

  const testAttachments: MappedAttachment[] = [];
  if (record.evidence.trace) {
    testAttachments.push({
      kind: "path",
      name: "trace",
      contentType: "application/vnd.allure.playwright-trace",
      path: joinRelative(record.evidence.dir, record.evidence.trace),
    });
  }
  for (const screenshot of record.evidence.screenshots) {
    testAttachments.push({
      kind: "path",
      name: screenshot.file,
      contentType: "image/png",
      path: joinRelative(record.evidence.dir, screenshot.file),
    });
  }

  return {
    test: {
      name: pickle.name,
      templateName: scenario?.name ?? pickle.name,
      description: resolveDescription(gherkinDocument, scenario),
      featureName,
      labels,
      links: declaredLinks,
      parameters: [...buildExampleParameters(gherkinDocument, pickle), ...declaredParameters, ...contextParameters],
      startMs: scenarioStartMs,
      stopMs: scenarioStopMs,
      attachments: testAttachments,
      message: failure?.message,
    },
    steps: stepMappings.map((entry) => entry.step),
    hooks: hookMappings.map((entry) => entry.hook),
  };
}
