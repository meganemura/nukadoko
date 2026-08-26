import type {
  Background,
  Examples,
  GherkinDocument,
  Pickle,
  PickleStep,
  PickleStepArgument,
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
// one identifiable place. One pickle becomes one Allure test result
// (`mapScenario`) — the same grain allure-cucumberjs itself uses, verified
// against its own 3.10.2 source and a captured run's own output. `mapGwtStep`
// maps one pickle step's own record/step record/gherkin context onto one
// entry of that result's own `steps[]`, never a test of its own; `mapHooks`
// turns a scenario's own before/after hooks into fixtures, as it already
// did. No `allure-js-commons` import (not even a type-only one) and no
// `node:fs`: every input here is already resolved by a caller (emitter.ts
// reads/redacts step records itself, resolves the project name via
// identity.ts, and buffers each `mapGwtStep` call's own result until the
// scenario ends), so every function here can be driven entirely from
// fixture data in a test, with no real allure-results directory and no
// disk-touching allure-js runtime anywhere in the call graph. emitter.ts is
// the only place that turns the plain data these functions return into
// actual `ReporterRuntime` calls.
//
// **One result, not one per step.** A step has no history-worthy identity
// of its own (see the next paragraph), so nothing here ever tries to build
// one for a `steps[]` entry: no `historyId`-feeding parameter lives on it,
// and the Allure step-result model itself carries no `labels`/`links` field
// to hold one even if it did. Everything that keeps a run recognizable
// across other runs — `fullName`, `historyId`, the visible Examples-row
// parameters — lives on the one result `mapScenario` returns, matching the
// grain allure-cucumberjs itself uses.
//
// **Why a scenario, not a step, carries history**: a *scenario* has content
// of its own to build a stable identity from — its own gherkin name, its own
// Examples row (when it has one), and its own ordered step text — none of
// which need position or an invented counter to stay meaningful across
// runs. `mapScenario`'s own `fullName` (built by emitter.ts) carries only
// the scenario's name (never a run id), and every one of its parameters
// that participates in `historyId` is deterministic from the scenario's own
// definition: two runs of the same scenario hash the same, and two Scenario
// Outline rows or two identically-named scenarios that actually differ hash
// apart. Only a scenario whose name, Examples row, and full ordered step
// text are *all* identical to another scenario's stays indistinguishable
// from it — no link is safer than a wrong one, and this is the one case
// nothing in a gherkin document can tell apart.
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
   * entirely). A plain string literal, not allure-js-commons' own
   * `ParameterMode` enum import: that type is itself already `"hidden" |
   * "masked" | "default"`, a plain string union, so this narrower field is
   * directly assignable to it with no cast needed at the one call site
   * (emitter.ts) that hands these straight to the SDK. */
  readonly mode?: "hidden";
}

/** A child step nested inside a `steps[]` entry or a hook's own fixture — a
 * declared log line (`mapDeclared`, always zero-width, `startMs ===
 * stopMs`, `"passed"`), one entry of a step's own `sections`/`polls`/
 * `actions` timeline (`mapTimelineChildSteps`, below), or one of a step's
 * own `calls` (`mapCalls`, below), each of which carries its own real
 * duration and outcome. One shape for all three keeps `writeChildSteps`
 * (emitter.ts) from needing to know which kind of child step it is
 * rendering. */
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
 * carries content this module already built in memory (a CSV table, a step
 * record's own JSON) and must be paired with an explicit `fileExtension`
 * (verified against allure-js-commons' own API: a Buffer attachment gets no
 * extension from a source path to infer one from). */
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
 * `record.hooks[].type` itself now also has `"after_step"` — allure-js-
 * commons' own `FixtureType` is that exact same closed union (no third kind
 * exists to map onto), and the Allure side gets no new concept: an
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

/** One `steps[]` entry — the Allure step-result model's own shape (verified
 * against a captured allure-cucumberjs run: `status`, `statusDetails`,
 * `stage`, `steps`, `attachments`, `parameters`, `start`, `name`, `stop`,
 * nothing else). It carries no `labels`/`links` field at all, which is why
 * a step's own declared label/link has nowhere to land here — `mapGwtStep`
 * returns those separately for the caller to fold onto the one result that
 * does have somewhere to put them (`MappedGwtStepOutcome`, below). */
export interface MappedGwtStep {
  readonly name: string;
  readonly status: MappedStatus;
  readonly message?: string;
  readonly startMs: number;
  readonly stopMs: number;
  readonly attachments: MappedAttachment[];
  readonly parameters: MappedParameter[];
  readonly childSteps: MappedChildStep[];
}

/** What `mapGwtStep` hands back for one pickle step: the `steps[]` entry
 * itself, plus the two things that entry's own shape has no room for and
 * must bubble up instead — a declared label/link (`ctx.declare`-style
 * facade calls from step glue) and, when this step's own failure resolved
 * to a classified `ErrorKind`, that classification. `failure` exists so the
 * caller (`mapScenario`) can give the result itself a category to land in
 * instead of Allure 3's built-in "Product errors" catch-all, without
 * `mapScenario` re-deriving a classification it has no step record of its
 * own to compute from. */
export interface MappedGwtStepOutcome {
  readonly step: MappedGwtStep;
  readonly declaredLabels: readonly MappedLabel[];
  readonly declaredLinks: readonly MappedLink[];
  /** `message` carries the `[nukadoko.failure=<kind>]` marker
   * (`buildFailureMarker`, below) that categories.ts's own regexes match
   * against — never stripped, since that marker is the one thing standing
   * between a real category and Allure 3's "Product errors" catch-all.
   * `rawMessage` is the same failure with that marker peeled back off,
   * `stepRecord.error.message`/`hook.error.message` exactly as the
   * contract layer produced it — for a Playwright failure this is
   * routinely a multi-line call-log block already, which is what
   * `mapScenario`'s own `trace` field (fed by `firstFailure`, below) is
   * for: a detail pane distinct from the one-line marked summary. */
  readonly failure?: { readonly kind: ErrorKind; readonly message: string; readonly rawMessage: string };
}

export interface MapGwtStepInput {
  /** This step's own 0-based position in both `record.steps` and
   * `pickle.steps` — used to resolve this step's own gherkin keyword and
   * its own `argument` (data table/doc string), below. */
  readonly index: number;
  readonly record: ScenarioStepRecord;
  /** The exact in-memory object `run-scenario.ts`'s own `writeStepRecord`
   * call just persisted for this step, or `null` for a step with no step
   * record of its own at all (skipped, undefined, ambiguous, or a
   * never-began refusal) — never a step record that exists on disk but
   * could not be read back: `pushStepRecord`'s own seam hands the caller
   * the object it already has, so there is nothing to re-read. */
  readonly stepRecord: StepRecord | null;
  /** The moment this step's own record was appended (run-scenario.ts's
   * `pushStepRecord`) — the zero-width anchor for a step with no step
   * record of its own. */
  readonly finishedAt: Date;
  readonly gherkinDocument: GherkinDocument;
  readonly pickle: Pickle;
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
// mapGwtStep below reads) — a separate walk from collectScenarios above,
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

/** The gherkin `keyword` (e.g. `"Given "`, trailing space included, `"And "`
 * left exactly as written rather than resolved to the Given/When/Then it
 * stands in for — verified against a captured allure-cucumberjs run, whose
 * own step name for an And line reads literally `"And another passing step
 * via And"`) for the pickle step at `pickleSteps[index]`, or `undefined`
 * when it can't be resolved (index out of range, no astNodeIds, or the id
 * isn't in `stepIds` — `mapGwtStep` falls back to the bare step text in
 * that case). */
function resolveStepKeyword(
  stepIds: ReadonlyMap<string, Step>,
  pickleSteps: readonly PickleStep[],
  index: number,
): string | undefined {
  const astNodeId = pickleSteps[index]?.astNodeIds[0];
  return astNodeId !== undefined ? stepIds.get(astNodeId)?.keyword : undefined;
}

/** `"<keyword><text>"` for pickle step `index`, or bare `text` when the
 * keyword can't be resolved — shared by `mapGwtStep` (a step that has
 * already run, `text` read off its own step record) and emitter.ts's own
 * progress snapshot (a step only planned so far, `text` read straight off
 * `pickle.steps[index]`), so a step's own name is identical whether a
 * viewer is looking at it before it ran or after: a name that changed
 * shape the moment a step actually finished would read as a different step
 * entirely, not an update to the same one. */
export function buildStepName(gherkinDocument: GherkinDocument, pickle: Pickle, index: number, text: string): string {
  const stepIds = collectGherkinSteps(gherkinDocument);
  const keyword = resolveStepKeyword(stepIds, pickle.steps, index);
  return keyword !== undefined ? `${keyword}${text}` : text;
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

/** One Examples row's own cells as visible parameters — every cell, not
 * just the ones a header names: a row can carry more cells than the header
 * has names for (or the header can be entirely absent), and every one of
 * them still has to reach the report somehow. A cell with no header of its
 * own is named `arg<index>` (verified against a captured allure-cucumberjs
 * run's own reporter source, `paramName = ... : "arg".concat(index)`),
 * never silently dropped the way iterating the header list alone would
 * drop it. */
export function buildExampleParameters(doc: GherkinDocument, pickle: Pickle): MappedParameter[] {
  const hit = resolveExampleRow(doc, pickle);
  if (!hit) {
    return [];
  }
  const headers = hit.examples.tableHeader?.cells.map((cell) => cell.value) ?? [];
  return hit.row.cells.map((cell, index) => ({ name: headers[index] ?? `arg${index}`, value: cell.value }));
}

/** The hidden `nukadoko.scenario.steps` identity parameter's own value —
 * every one of this pickle's own step texts, joined in order. Reads
 * `pickle.steps[].text`, never `record.steps[].text`: the two mirror each
 * other exactly (record-types.ts's own contract, "record.steps[i] mirrors
 * pickle.steps[i]"), and `pickle` is the one of the two already frozen
 * before a single step of this scenario ever runs — `mapScenario`'s own
 * header explains why that is exactly what lets a progress snapshot
 * (written before a `ScenarioRecord` exists at all) land on the same
 * historyId a later final result confirms. */
export function buildScenarioStepsSignature(pickle: Pickle): string {
  return pickle.steps.map((step) => step.text).join("\n");
}

/** The whole Examples table this pickle's own row belongs to, as one
 * "Examples" text/csv attachment on the scenario's own result — every row,
 * not just this pickle's own, the same "the whole table, not one row" shape
 * a captured allure-cucumberjs run's own attachment carries (every row of a
 * Scenario Outline gets the exact same CSV, header and all rows included).
 * A Scenario Outline with more than one `Examples:` block gets only the one
 * block this pickle's own row belongs to, a deliberate narrowing from
 * allure-cucumberjs's own "every block the scenario has, regardless of
 * which one this pickle came from": real Gherkin almost never declares two
 * Examples blocks under one outline, and one Examples attachment, singular,
 * is simpler to reason about than one per block plus a name to tell them
 * apart. `undefined` when the CSV would be entirely empty (no header and no
 * rows), the same "never emit a synthetic thing with nothing to say"
 * convention this file already follows elsewhere. */
function buildExamplesAttachment(doc: GherkinDocument, pickle: Pickle): MappedAttachment | undefined {
  const hit = resolveExampleRow(doc, pickle);
  if (!hit) {
    return undefined;
  }
  const headerLine = (hit.examples.tableHeader?.cells.map((cell) => cell.value) ?? []).join(",");
  const bodyLine = hit.examples.tableBody.map((row) => row.cells.map((cell) => cell.value).join(",")).join("\n");
  if (headerLine === "" && bodyLine === "") {
    return undefined;
  }
  return {
    kind: "buffer",
    name: "Examples",
    contentType: "text/csv",
    content: `${headerLine}\n${bodyLine}\n`,
    fileExtension: ".csv",
  };
}

/** This pickle step's own data table (Gherkin's own `argument.dataTable`),
 * as a "Data table" text/csv attachment on its own `steps[]` entry — the
 * same name and CSV shape (rows joined by `,`, each row followed by `\n`)
 * a captured allure-cucumberjs run's own attachment carries. `undefined`
 * for a step with no data table at all. */
function buildDataTableAttachment(argument: PickleStepArgument | undefined): MappedAttachment | undefined {
  const table = argument?.dataTable;
  if (!table || table.rows.length === 0) {
    return undefined;
  }
  const content = `${table.rows.map((row) => row.cells.map((cell) => cell.value).join(",")).join("\n")}\n`;
  return { kind: "buffer", name: "Data table", contentType: "text/csv", content, fileExtension: ".csv" };
}

/** This pickle step's own doc string (Gherkin's own `argument.docString`),
 * as a "Doc string" text attachment on its own `steps[]` entry. A captured
 * allure-cucumberjs run drops a doc string entirely (it never attaches
 * one) — a deliberate divergence here, not a gap: a doc string is content
 * the scenario author wrote on purpose, and dropping it would throw away a
 * fact this tool could keep for free. `undefined` for a step with no doc
 * string at all. */
function buildDocStringAttachment(argument: PickleStepArgument | undefined): MappedAttachment | undefined {
  const docString = argument?.docString;
  if (!docString) {
    return undefined;
  }
  return { kind: "buffer", name: "Doc string", contentType: "text/plain", content: docString.content, fileExtension: ".txt" };
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

/** `<projectName>.<posixPath's own segments, dot-joined>`, or the segments
 * alone with no project name — verified against allure-js-commons 3.10.2's
 * own `getPackageLabel` (node_modules/allure-js-commons/dist/esm/sdk/
 * reporter/utils/labels.js), which does the same `[projectName, ...
 * pathParts].join(".")` this module never calls directly (that function
 * resolves the project name and the relative path itself, from a real
 * filesystem path — this module takes both as plain strings its caller
 * already resolved, the same reasoning `posixPath` itself already
 * follows). */
function buildPackageLabelValue(projectName: string | null, posixPath: string): string {
  const segments = posixPath.split("/");
  return (projectName !== null ? [projectName, ...segments] : segments).join(".");
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
  // `excluded` is deliberately never set here: a declared parameter this
  // function builds only ever lands on a step's own `steps[]` entry
  // (`mapGwtStep`'s own `parameters.push(...declared.parameters)`, below)
  // or a hook's own fixture (`mapHooks`'s own `declaredParameters`) — never
  // on the one `parameters` array `getTestResultHistoryId` actually reads
  // (the scenario-level result's own, built by `mapScenario`), so marking
  // one `excluded` here would change nothing about historyId at all. The
  // parameters that *do* feed historyId — `buildExampleParameters`'s own
  // Examples-row cells and `buildScenarioStepsSignature`'s own hidden
  // step-text join, both below — are read straight off `pickle`, frozen
  // before a single step of this scenario ever runs. That is the premise
  // emitter.ts's own progress snapshot relies on: written before a
  // `ScenarioRecord` exists at all, it can still compute the exact same
  // historyId the final result will, because neither of those two
  // parameter sources ever needed one to exist in the first place.
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
  /** Unset except alongside a classified `kind` — the one case `message`
   * itself carries the `[nukadoko.failure=<kind>]` marker (`markedMessage`,
   * below) rather than the contract layer's own text verbatim. */
  readonly rawMessage?: string;
  readonly kind?: ErrorKind;
}

/** `stepRecord` is exactly what the caller already has for this step —
 * never a disk read (`MapGwtStepInput.stepRecord`'s own doc comment) —
 * `stepRecord` is `null` exactly when `step.step_record_id` is `null` (a
 * step that never began at all — skipped, undefined, ambiguous, or a
 * never-began refusal). */
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
    return {
      status: statusForKind(kind),
      message: markedMessage(kind, stepRecord.error.message),
      rawMessage: stepRecord.error.message,
      kind,
    };
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
  return {
    status: statusForKind(kind),
    message: markedMessage(kind, hook.error.message),
    rawMessage: hook.error.message,
    kind,
  };
}

// --- sections + polls + actions -> one child-step timeline ---
//
// `PollRecord.outcome` -> `MappedStatus`: `"resolved"` is what a poll's
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
 * same distinction the step record's own `error.kind` already draws — never
 * the contract layer failing to reach a verdict. */
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
 * JSON-stringified: a `Parameter`'s own `value` field is a plain string. */
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

// --- one pickle step -> one steps[] entry ---

export function mapGwtStep(input: MapGwtStepInput): MappedGwtStepOutcome {
  const { index, record, stepRecord, finishedAt, gherkinDocument, pickle } = input;

  const outcome = resolveStepOutcome(record, stepRecord);

  let startMs: number;
  let stopMs: number;
  if (stepRecord) {
    startMs = Date.parse(stepRecord.started_at);
    stopMs = Date.parse(stepRecord.finished_at);
  } else {
    // A step with no step record (skipped/undefined/ambiguous, or a
    // never-began refusal) has no time of its own to report — zero-width,
    // anchored to the moment this step's own record was appended
    // (`MapGwtStepInput.finishedAt`'s own doc comment).
    const t = finishedAt.getTime();
    startMs = t;
    stopMs = t;
  }

  const attachments: MappedAttachment[] = [];
  // This step's own `argument` (Gherkin's data table / doc string), first —
  // what this step was given, ahead of what happened when it ran.
  const argument = pickle.steps[index]?.argument;
  const dataTableAttachment = buildDataTableAttachment(argument);
  if (dataTableAttachment !== undefined) {
    attachments.push(dataTableAttachment);
  }
  const docStringAttachment = buildDocStringAttachment(argument);
  if (docStringAttachment !== undefined) {
    attachments.push(docStringAttachment);
  }

  const parameters: MappedParameter[] = [];
  let declared: MappedDeclared = EMPTY_DECLARED;
  let timelineChildSteps: MappedChildStep[] = [];
  let callChildSteps: MappedChildStep[] = [];

  if (stepRecord) {
    parameters.push({ name: "step record id", value: stepRecord.step_record_id });
    parameters.push({
      name: "mutates (declared)",
      value: stepRecord.mutates === null ? "not declared" : stepRecord.mutates ? "true" : "false",
    });
    parameters.push({ name: "http reads (observed)", value: String(stepRecord.observed.http_reads) });
    parameters.push({ name: "http writes (observed)", value: String(stepRecord.observed.http_writes) });
    if (stepRecord.world) {
      parameters.push({ name: "world reads (observed)", value: stepRecord.world.reads.join(", ") });
      parameters.push({ name: "world writes (observed)", value: stepRecord.world.writes.join(", ") });
    }
    if (stepRecord.used && stepRecord.used.length > 0) {
      parameters.push({
        name: "used step records",
        value: stepRecord.used.map((entry) => entry.step_record_id).join(", "),
      });
    }
    if (stepRecord.required_env && stepRecord.required_env.length > 0) {
      parameters.push({ name: "required env", value: stepRecord.required_env.join(", ") });
    }
    if (stepRecord.page_events) {
      const consoleErrors = pageEventCount(
        stepRecord.page_events.console_errors,
        stepRecord.page_events.truncated?.console_errors,
      );
      if (consoleErrors !== undefined) {
        parameters.push({ name: "console errors (observed)", value: consoleErrors });
      }
      const pageErrors = pageEventCount(
        stepRecord.page_events.page_errors,
        stepRecord.page_events.truncated?.page_errors,
      );
      if (pageErrors !== undefined) {
        parameters.push({ name: "page errors (observed)", value: pageErrors });
      }
      const failedRequests = pageEventCount(
        stepRecord.page_events.failed_requests,
        stepRecord.page_events.truncated?.failed_requests,
      );
      if (failedRequests !== undefined) {
        parameters.push({ name: "failed requests (observed)", value: failedRequests });
      }
    }

    // The whole step record, verbatim, as one JSON attachment — every step
    // whose step record exists, success or failure alike, never only the
    // fields this module happens to map individually above. Already
    // redacted before it ever reached disk (write-step-record.ts's own
    // callers), so no second redaction pass belongs here.
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
    // same path-attachment shape as trace/screenshots above, `name` kept as
    // the step's own. `contentType` is guessed from `file`'s own extension;
    // an unrecognized extension falls back to `application/octet-stream`
    // rather than a guess this module cannot verify.
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
    parameters.push(...declared.parameters);
    timelineChildSteps = mapTimelineChildSteps(stepRecord, Date.parse(stepRecord.started_at));
    callChildSteps = mapCalls(stepRecord.calls);
  }

  // `record.steps[i]` mirrors `pickle.steps[i]` (record-types.ts's own
  // header) — the official cucumberjs allure adapter names a step
  // `"<keyword><text>"` (e.g. "Given a passed step"), and the gherkin
  // `keyword` itself already carries its own trailing space, so no
  // separator is added here (`buildStepName`, above).
  const name = buildStepName(gherkinDocument, pickle, index, record.text);

  const step: MappedGwtStep = {
    name,
    status: outcome.status,
    message: outcome.message,
    startMs,
    stopMs,
    attachments,
    parameters,
    // Declared log lines first (unchanged position and rendering), the
    // step's own sections/polls/actions timeline second, this step's own
    // `calls` last — additive, never reordering what was already there
    // (this section's own header explains why `calls` gets its own
    // trailing, nested group instead of folding into the `at`-ordered
    // timeline).
    childSteps: [...declared.childSteps, ...timelineChildSteps, ...callChildSteps],
  };

  return {
    step,
    declaredLabels: declared.labels,
    declaredLinks: declared.links,
    failure:
      outcome.kind !== undefined && outcome.message !== undefined
        ? { kind: outcome.kind, message: outcome.message, rawMessage: outcome.rawMessage ?? outcome.message }
        : undefined,
  };
}

// --- the first classified failure, across every step then every hook ---

/** The first `steps` entry whose own failure resolved to a classified
 * `ErrorKind`, or — when no step's own failure did (every step reads
 * skipped because a Before hook stopped the scenario before any of them
 * ran) — the first classified hook failure instead. Read in that order
 * because a step's own failure is always the more specific fact when one
 * exists; falling back to a hook only covers the case a step-only search
 * would otherwise leave with no category at all (Allure 3's own "Product
 * errors" catch-all) despite the scenario having failed for a perfectly
 * classifiable reason.
 *
 * Exported for emitter.ts's own progress snapshot, which calls this with
 * `hooks: []` (a hook's own outcome is never known mid-scenario — hooks are
 * only mapped once, at `endScenario`) to classify whatever the buffered
 * steps have already shown by the time a given step finished. */
export function firstFailure(
  steps: readonly MappedGwtStepOutcome[],
  hooks: readonly ScenarioHookRecord[],
): { readonly kind: ErrorKind; readonly message: string; readonly rawMessage: string } | undefined {
  for (const outcome of steps) {
    if (outcome.failure !== undefined) {
      return outcome.failure;
    }
  }
  for (const hook of hooks) {
    const outcome = resolveHookOutcome(hook);
    if (outcome.kind !== undefined && outcome.message !== undefined) {
      return { kind: outcome.kind, message: outcome.message, rawMessage: outcome.rawMessage ?? outcome.message };
    }
  }
  return undefined;
}

// --- one pickle -> one Allure test result ---

export interface MapScenarioInput {
  readonly record: ScenarioRecord;
  readonly gherkinDocument: GherkinDocument;
  readonly pickle: Pickle;
  /** The feature file's root-relative path, already POSIX-normalized
   * (identity.ts's own `toPosixPath`) — used for the `package` label here
   * (`fullName`/`titlePath` themselves are built by emitter.ts, which
   * already has this same value). */
  readonly posixPath: string;
  /** The host project's own `package.json` name, or `null` — resolved once
   * by emitter.ts (identity.ts's own `resolveProjectName`), never read from
   * disk here (this module's own header). */
  readonly projectName: string | null;
  /** Every one of this pickle's own steps, already mapped by `mapGwtStep`
   * and buffered by the caller (emitter.ts) in `record.steps`' own order —
   * `endScenario` only runs once every step has already finished, so this
   * function never calls `mapGwtStep` itself. */
  readonly steps: readonly MappedGwtStepOutcome[];
}

export interface MappedScenarioTest {
  readonly name: string;
  readonly featureName: string;
  readonly description?: string;
  readonly status: MappedStatus;
  readonly message?: string;
  /** The same classified failure's own raw, unmarked text (`firstFailure`'s
   * own `rawMessage`) — set exactly when `message` is, never on its own.
   * emitter.ts wires this into `statusDetails.trace`, a pane distinct from
   * `statusDetails.message`, which keeps carrying the `[nukadoko.failure=
   * <kind>]`-marked summary categories.ts's own regexes need. */
  readonly trace?: string;
  readonly startMs: number;
  readonly stopMs: number;
  readonly labels: MappedLabel[];
  readonly links: MappedLink[];
  readonly parameters: MappedParameter[];
  readonly attachments: MappedAttachment[];
  readonly steps: MappedGwtStep[];
}

export function mapScenario(input: MapScenarioInput): MappedScenarioTest {
  const { record, gherkinDocument, pickle, posixPath, projectName, steps } = input;

  const scenario = resolveScenario(gherkinDocument, pickle);
  const featureName = gherkinDocument.feature?.name ?? "";

  const startMs = Date.parse(record.started_at);
  const stopMs = Date.parse(record.finished_at);

  // This result's own identity-breaking parameter: two scenarios can share
  // a gherkin name (this module's own header), and a shared name with no
  // Examples row of its own (the Scenario Outline case `buildExampleParameters`
  // already covers) would otherwise hash to the exact same `historyId`,
  // wrongly folding the second one into the first one's history.
  // `buildScenarioStepsSignature` reads `pickle.steps[].text` directly, not
  // `record.steps[].text` — the two mirror each other exactly
  // (record-types.ts's own contract), and reading the pickle is what lets
  // emitter.ts's own progress snapshot compute this identical value before
  // a `ScenarioRecord` exists at all (this module's own header, just
  // above). `status` is deliberately excluded from this join: a step's
  // outcome changing from one run to the next is exactly the "regressed"/
  // "fixed" transition this identity exists to make visible, not a reason
  // to treat the two runs as different scenarios.
  const identityParameters: MappedParameter[] = [
    { name: "nukadoko.scenario.steps", value: buildScenarioStepsSignature(pickle), mode: "hidden" },
  ];

  const contextParameters: MappedParameter[] = [
    { name: "environment", value: record.environment, excluded: true },
    ...(record.session !== null ? [{ name: "session", value: record.session, excluded: true }] : []),
    ...(record.target_version !== undefined ? [{ name: "target_version", value: record.target_version, excluded: true }] : []),
  ];

  // A step's own declared label/link (`ctx.declare`-style facade calls from
  // step glue) has no home on its own `steps[]` entry any more (that model
  // carries neither field, `MappedGwtStep`'s own header) — this result is
  // the only test left to reach, the same place a runtime label/link call
  // from step glue already lands in allure-cucumberjs itself, which has
  // only ever had the one test per scenario this module now also has.
  const declaredLabels = steps.flatMap((outcome) => outcome.declaredLabels);
  const declaredLinks = steps.flatMap((outcome) => outcome.declaredLinks);

  const classifiedFailure = record.status === "failed" ? firstFailure(steps, record.hooks) : undefined;

  const labels: MappedLabel[] = [
    { name: "feature", value: featureName },
    { name: "package", value: buildPackageLabelValue(projectName, posixPath) },
    ...resolveTagLabels(pickle),
    { name: "env", value: record.environment },
    ...declaredLabels,
    // This scenario's own outcome, direct — the first step (or, failing
    // that, hook) whose own failure resolved to a classified `ErrorKind`
    // gives this result a category to land in instead of Allure 3's
    // built-in, uninformative "Product errors" catch-all.
    ...(classifiedFailure !== undefined ? [{ name: "nukadoko.failure", value: classifiedFailure.kind }] : []),
  ];

  const attachments: MappedAttachment[] = [];
  const examplesAttachment = buildExamplesAttachment(gherkinDocument, pickle);
  if (examplesAttachment !== undefined) {
    attachments.push(examplesAttachment);
  }
  // Scenario-wide browser evidence (the legacy whole-scenario trace field,
  // and the final-state screenshot `dispose()` takes) attaches directly to
  // this result now, never a synthetic fixture of its own: by the time
  // `endScenario` runs, `record.evidence` already carries this run's own
  // final capture (run-scenario.ts's own `dispose()` call populates it
  // before this function's caller ever sees the record), so there is no
  // ordering reason left to defer this evidence onto a fixture the way an
  // earlier design (before this result existed at all) once had to.
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

  return {
    name: pickle.name,
    featureName,
    description: resolveDescription(gherkinDocument, scenario),
    status: record.status,
    message: classifiedFailure?.message,
    trace: classifiedFailure?.rawMessage,
    startMs,
    stopMs,
    labels,
    links: dedupeLinks(declaredLinks),
    parameters: [...buildExampleParameters(gherkinDocument, pickle), ...contextParameters, ...identityParameters],
    attachments,
    steps: steps.map((outcome) => outcome.step),
  };
}

// --- hooks -> fixtures (unchanged: hooks stay fixtures, mapped once the
// whole scenario is over) ---

interface HookMapping {
  readonly hook: MappedHook;
  /** A hook's own declared parameters (`this.attach`/`ctx.declare`-style
   * facade calls made from inside a Before/After body) land on that hook's
   * own fixture (`FixtureResult.parameters` — verified against allure-js-
   * commons' own model: a fixture carries the same `Executable` shape a
   * step or test does). A hook's own declared links and labels, unlike
   * parameters, have no home any more: the fixture model has no
   * `links`/`labels` field at all to hold them (unlike the scenario's own
   * result, which does — a step's own declared label/link is hoisted there
   * instead, `mapScenario`'s own header). Dropped, not silently miscounted:
   * attachments and log lines a hook declares still land on that hook's
   * own fixture exactly as before (`hook.attachments`/`hook.childSteps`
   * below), unaffected. */
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
    // what a step's own `Date.parse(stepRecord.started_at)` would have been
    // if a hook had one.
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
    // `actions` already are (`mapGwtStep`, above) — same contentType, same
    // `mapTimelineChildSteps` merge/truncation-marker function, no separate
    // rule for a hook. `hook.trace` is relative to the *scenario's* own
    // evidence dir, unlike a step's own step record `evidence.trace`, which
    // is relative to that step's own step record dir — `joinRelative` takes
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
        // Declared log lines first (same order `mapGwtStep` already uses for
        // a step's own declared.childSteps + timeline), the actions
        // timeline after.
        childSteps: [...declared.childSteps, ...timelineChildSteps],
      },
      declaredParameters: declared.parameters,
    };
  });
}
