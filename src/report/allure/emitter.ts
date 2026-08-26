import path from "node:path";
import { Status, type StepResult, type TestResult } from "allure-js-commons";
import type { Category, EnvironmentInfo } from "allure-js-commons/sdk";
import {
  ReporterRuntime,
  createStepResult,
  createTestResult,
  getEnvironmentLabels,
  getFrameworkLabel,
  getHostLabel,
  getLanguageLabel,
  getTestResultHistoryId,
  getTestResultTestCaseId,
  getThreadLabel,
  randomUuid,
} from "allure-js-commons/sdk/reporter";
import type { GherkinDocument, Pickle } from "@cucumber/messages";
import type { WritableSink } from "../../cli/writable-sink.js";
import type { StepRecord } from "../../record/types.js";
import type { ScenarioRecord, ScenarioStepRecord } from "../../run/record-types.js";
import { redactString } from "../../secrets/redact.js";
import type { SecretSet } from "../../secrets/types.js";
import { buildCategories } from "./categories.js";
import { buildFullName, buildTitlePath, resolveProjectName, toPosixPath } from "./identity.js";
import {
  buildExampleParameters,
  buildScenarioStepsSignature,
  buildStepName,
  firstFailure,
  mapGwtStep,
  mapHooks,
  mapScenario,
  type MappedAttachment,
  type MappedChildStep,
  type MappedGwtStep,
  type MappedGwtStepOutcome,
  type MappedHook,
  type MappedParameter,
  type MappedScenarioTest,
  type MappedStatus,
} from "./map-scenario.js";
import { createAtomicWriter } from "./writer.js";

// Responsibility: the thin layer that turns map-scenario.ts's flat
// description into actual `ReporterRuntime` calls — the only module in this
// directory that imports allure-js-commons for its running behavior
// (categories.ts/writer.ts also import it, but only for static Category/
// Writer plumbing) and the only one that touches the filesystem beyond what
// the `Writer` itself does (resolving the project name).
//
// One pickle, one Allure test result, written once — at `endScenario`, never
// per step. `beginScenario` opens this scenario's own Allure *scope* and
// clears this module's own step buffer before its first step can possibly
// run; `emitStep` maps that one step (map-scenario.ts's own `mapGwtStep`)
// and appends the result to the buffer — its only I/O is the progress
// snapshot this file's own header below describes, never the real result
// itself; `endScenario` folds the whole buffer into one `steps[]` array
// (map-scenario.ts's own `mapScenario`), maps this scenario's own hooks into
// fixtures under the same scope, writes the one test, and only then writes
// the scope's own container (`writeScope`). A step that never runs a real
// body (never-began, skipped by an earlier failure) still gets its own
// `emitStep` call and its own `steps[]` entry — `run-scenario.ts`'s own
// `pushStepRecord` is the one place that appends to `record.steps` and
// calls this, so every element of that array gets exactly one call, in
// order, with no gaps.
//
// This module holds state across `beginScenario`/`emitStep`/`endScenario`
// (`currentScopeUuid`, the step buffer, and the progress-snapshot state
// below) — safe because `nuka run` executes scenarios strictly
// sequentially, never two at once.
//
// **A bad attachment now costs the whole scenario's own Allure result, not
// just one step's.** Every `writeAttachment` call for every step, every
// result-level attachment, and the final `writeTest` all happen inside one
// `try` block at `endScenario` — when everything used to be its own test
// (before this design), a broken reference in step 2 only lost step 2's own
// file; now that a scenario is one result, the same failure loses the
// scenario's entire Allure output (`record.json` on disk, the actual source
// of truth, is unaffected either way). Accepted rather than fixed with a
// second, per-attachment try/catch: the damage unit was always "one test",
// and one test is now the whole scenario.
//
// A Before hook's own failure still leaves every step it stops from ever
// running reported `"skipped"`, never `"failed"` — the failure itself is
// visible in that Before fixture's own detail view. The result's own status
// is `record.status` directly, which the scenario record already sets to
// `"failed"` whenever any of its steps didn't pass (record-types.ts), and
// map-scenario.ts's own `firstFailure` search falls back to a classified
// hook failure exactly for this case, so a Before-hook-stopped scenario
// still lands in one of `nuka init`'s own seven categories instead of
// Allure 3's uninformative "Product errors" catch-all.
//
// Known limit: record.json carries no per-hook timestamp of its own, so
// every before-hook collapses to the scenario's own `started_at` and every
// after-hook to its `finished_at`, both zero-width (map-scenario.ts's own
// `mapHooks`).
//
// AllureEmitterOptions carries no `stateDir` of its own: a step's own step
// record is handed to `emitStep` directly by the caller (cli/run.ts,
// threaded from run-scenario.ts's own `onStepFinished`) — this emitter
// never reads a record.json off disk itself, unlike the messages emitter
// (src/report/messages/emitter.ts), which still does via
// src/report/step-records.ts's `readStepRecordsForScenario`.
//
// Beyond that one real result, `beginScenario` and every `emitStep` also
// write a disposable *progress* snapshot — never a substitute for the real
// result, never itself the record `record.json` on disk already is. Each
// one is written under its own fresh uuid (writer.ts's own
// `writeProgressSnapshot`, `<uuid>-progress-result.json`) because
// `allure watch` only ever discovers a genuinely new file path (polls every
// 300ms, ignores an overwrite of a path it already read — verified against
// @allurereport/core 3.15.0), so updating one file in place would only ever
// be seen once. Every snapshot still carries the exact same `fullName`/
// `testCaseId`/`historyId`/non-excluded parameters the eventual real result
// will (map-scenario.ts's own `buildScenarioStepsSignature`/
// `buildExampleParameters`, both read straight off `pickle`, frozen before
// a single step runs), computed with allure-js-commons' own
// `getTestResultTestCaseId`/`getTestResultHistoryId` — the same formula
// `ReporterRuntime.stopTest` itself calls for the real result, never
// reimplemented here. That shared identity is what makes `allure watch`'s
// own retry merge (@allurereport/core 3.15.0's `RetrySubstore`) treat every
// snapshot and the eventual real result as retries of one same test,
// picking whichever has the highest `start` as canonical. Every snapshot's
// own `start` is frozen to one value below the scenario's own real start
// (`BeginScenarioInput.startedAt`'s own doc comment, below), so the real
// result — whose own `start` is `record.started_at` itself — always
// outranks every snapshot that came before it; among the snapshots
// themselves, `RetrySubstore`'s own tie-break on ingest order picks
// whichever was written last, which is exactly "the live view always shows
// the latest completed step" without ever touching a path `allure watch`
// has already read once. `endScenario` deletes every progress snapshot the
// scenario ever wrote the moment its real result lands, so a finished
// run's own `allure-results` directory never carries a stale one; `begin()`
// sweeps up whatever a previous run's own crash left behind, the same
// moment it (re)writes categories.json/environment.properties.

export interface AllureEmitterOptions {
  /** Absolute path. */
  readonly resultsDir: string;
  readonly rootDir: string;
  readonly environment: string;
  readonly targetVersion?: string;
  readonly secrets: SecretSet;
  readonly stderr: WritableSink;
}

export interface BeginScenarioInput {
  readonly pickle: Pickle;
  readonly gherkinDocument: GherkinDocument;
  readonly relativeFeaturePath: string;
  /** Captured by the caller (cli/run.ts) once, right before `runScenario`
   * itself runs — never later than that call's own `record.started_at`
   * (nothing async happens between the two), which is what keeps every
   * progress snapshot's own frozen `start` strictly below the eventual
   * real result's `start`: @allurereport/core 3.15.0's own
   * `RetrySubstore.compareResults` picks whichever same-identity result
   * has the higher `start` as canonical, so the real result — captured
   * later, hence numerically higher — always outranks every snapshot that
   * came before it, however many milliseconds of true drift separate this
   * timestamp from `record.started_at`'s own. */
  readonly startedAt: Date;
}

export interface EmitStepInput {
  readonly runId: string;
  readonly scenarioId: string;
  readonly environment: string;
  readonly session: string | null;
  readonly targetVersion?: string;
  readonly record: ScenarioStepRecord;
  /** The exact in-memory object run-scenario.ts's own `writeStepRecord`
   * call just persisted for this step, or `null` for a step with no step
   * record of its own at all — see map-scenario.ts's `MapGwtStepInput.
   * stepRecord` for the full reasoning. */
  readonly stepRecord: StepRecord | null;
  readonly index: number;
  readonly finishedAt: Date;
  readonly gherkinDocument: GherkinDocument;
  readonly pickle: Pickle;
  readonly relativeFeaturePath: string;
}

export interface EndScenarioInput {
  readonly record: ScenarioRecord;
  readonly gherkinDocument: GherkinDocument;
  readonly pickle: Pickle;
  readonly relativeFeaturePath: string;
}

export interface AllureEmitter {
  /** Writes categories.json and environment.properties, and deletes every
   * `*-progress-result.json` a previous run's own crash left behind. Once,
   * at the start of a run. */
  begin(): void;
  /** Opens this scenario's own scope, clears this module's own step
   * buffer, and writes this scenario's own initial progress snapshot —
   * every one of `input.pickle`'s own steps listed as planned, none of
   * them run yet. Never throws. */
  beginScenario(input: BeginScenarioInput): void;
  /** Maps one step, appends it to this scenario's own buffer, and writes an
   * updated progress snapshot reflecting the buffer so far — a fresh file,
   * replacing (by superseding, not overwriting: `endScenario` is what
   * deletes the old one) this scenario's own most recent snapshot.
   * `endScenario` is still what turns the whole buffer into the one real
   * Allure test. Never throws. */
  emitStep(input: EmitStepInput): void;
  /** Folds the buffered steps and this scenario's own hooks (and whatever
   * scenario-level evidence it collected) into one Allure test plus its own
   * fixtures, writes both, then writes the scope's own container. Deletes
   * every progress snapshot this scenario ever wrote, regardless of
   * whether the real result above wrote successfully. Never throws. */
  endScenario(input: EndScenarioInput): void;
}

function allureStatus(status: MappedStatus): Status {
  switch (status) {
    case "passed":
      return Status.PASSED;
    case "failed":
      return Status.FAILED;
    case "broken":
      return Status.BROKEN;
    case "skipped":
      return Status.SKIPPED;
  }
}

/** One already-finished child step (a declared log line, a timeline entry,
 * a call), reshaped for a progress snapshot — recurses on its own nested
 * `childSteps`, same as `emitter.ts`'s own `writeChildSteps` does for the
 * real result. `MappedChildStep` carries no attachments of its own at all
 * (its own header), so there is nothing here to strip the way
 * `mappedGwtStepToSnapshotStep`, below, has to. */
function mappedChildStepToSnapshotStep(child: MappedChildStep): StepResult {
  const result = createStepResult();
  result.name = child.name;
  result.status = allureStatus(child.status);
  result.start = child.startMs;
  result.stop = child.stopMs;
  if (child.parameters && child.parameters.length > 0) {
    result.parameters = [...child.parameters];
  }
  if (child.childSteps && child.childSteps.length > 0) {
    result.steps = child.childSteps.map(mappedChildStepToSnapshotStep);
  }
  return result;
}

/** One already-finished `steps[]` entry, reshaped for a progress snapshot:
 * every field `writeGwtSteps` (below) eventually renders for the real
 * result except attachments — a snapshot never carries one (this file's
 * own header: attachments are final-only, avoiding a duplicate,
 * possibly-still-being-copied reference racing the real result's own). */
function mappedGwtStepToSnapshotStep(step: MappedGwtStep): StepResult {
  const result = createStepResult();
  result.name = step.name;
  result.status = allureStatus(step.status);
  result.start = step.startMs;
  result.stop = step.stopMs;
  if (step.parameters.length > 0) {
    result.parameters = [...step.parameters];
  }
  if (step.childSteps.length > 0) {
    result.steps = step.childSteps.map(mappedChildStepToSnapshotStep);
  }
  return result;
}

/** One `steps[]` entry for a pickle step that has not run yet — named
 * exactly the way it will read once it actually finishes (`buildStepName`,
 * map-scenario.ts, shared with `mapGwtStep` itself), status left unset
 * (`createStepResult`'s own default), so a live viewer sees the whole plan
 * before any of it has happened. */
function plannedSnapshotStep(name: string): StepResult {
  const result = createStepResult();
  result.name = name;
  return result;
}

export function createAllureEmitter(options: AllureEmitterOptions): AllureEmitter {
  const projectName = resolveProjectName(options.rootDir);
  const writer = createAtomicWriter(options.resultsDir);
  const environmentInfo: EnvironmentInfo = {
    environment: options.environment,
    // `target_version` is a run-level value: unlike record.json/
    // step record.json, nothing has redacted it yet.
    ...(options.targetVersion !== undefined
      ? { target_version: redactString(options.targetVersion, options.secrets) }
      : {}),
  };
  const categories: Category[] = buildCategories();
  const runtime = new ReporterRuntime({ writer, categories, environmentInfo });

  // The state this module carries across `beginScenario`/`emitStep`/
  // `endScenario` — safe only because `nuka run` runs one scenario at a
  // time (this file's own header). All four are reset both before the
  // first `beginScenario` and once `endScenario` has cleared them, so a
  // stray `emitStep` call outside a scenario's own begin/end pair is a
  // no-op rather than attaching to the *previous* scenario's own scope or
  // buffer. `progressAnchorMs` is `null` exactly when there is no open
  // scope to write a snapshot under (mirrors `currentScopeUuid` itself);
  // `progressUuids` collects every progress snapshot's own uuid this
  // scenario has written so far, so `endScenario` knows exactly which
  // files to delete.
  let currentScopeUuid: string | null = null;
  let bufferedSteps: MappedGwtStepOutcome[] = [];
  let progressAnchorMs: number | null = null;
  let progressUuids: string[] = [];

  function toAbsolute(relativePath: string): string {
    return path.join(options.rootDir, relativePath);
  }

  function writeMappedAttachment(rootUuid: string, parentStepUuid: string | null, attachment: MappedAttachment): void {
    if (attachment.kind === "path") {
      runtime.writeAttachment(rootUuid, parentStepUuid, attachment.name, toAbsolute(attachment.path), {
        contentType: attachment.contentType,
        wrapInStep: false,
      });
    } else {
      runtime.writeAttachment(rootUuid, parentStepUuid, attachment.name, Buffer.from(attachment.content, "utf8"), {
        contentType: attachment.contentType,
        fileExtension: attachment.fileExtension,
        wrapInStep: false,
      });
    }
  }

  /** Renders one nested child-step tree (a declared log line, a
   * sections/polls/actions timeline entry, or a call) under `parentStepUuid`
   * — never a `steps[]` entry itself, which `writeGwtSteps` below renders
   * (a `MappedChildStep` carries no attachments/message of its own, unlike
   * a `MappedGwtStep`, which is the whole reason the two need separate
   * writer functions). */
  function writeChildSteps(
    rootUuid: string,
    childSteps: readonly MappedChildStep[],
    parentStepUuid: string | null,
  ): void {
    for (const child of childSteps) {
      const uuid = runtime.startStep(rootUuid, parentStepUuid, { name: child.name, start: child.startMs });
      if (uuid !== undefined) {
        runtime.updateStep(uuid, (s) => {
          s.status = allureStatus(child.status);
          if (child.parameters && child.parameters.length > 0) {
            s.parameters = [...s.parameters, ...child.parameters];
          }
        });
        if (child.childSteps && child.childSteps.length > 0) {
          writeChildSteps(rootUuid, child.childSteps, uuid);
        }
        runtime.stopStep(uuid, { stop: child.stopMs });
      }
    }
  }

  /** Renders every one of this result's own `steps[]` entries — one
   * `startStep`/`updateStep`/`stopStep` per Given/When/Then/And, each
   * nesting its own attachments and its own child-step tree
   * (`writeChildSteps`, above) exactly the way a step's own test used to
   * before step = test and scenario = test merged back into one. */
  function writeGwtSteps(rootUuid: string, steps: readonly MappedGwtStep[]): void {
    for (const step of steps) {
      const stepUuid = runtime.startStep(rootUuid, null, { name: step.name, start: step.startMs });
      if (stepUuid === undefined) {
        continue;
      }
      runtime.updateStep(stepUuid, (s) => {
        s.status = allureStatus(step.status);
        if (step.parameters.length > 0) {
          s.parameters = [...s.parameters, ...step.parameters];
        }
        if (step.message !== undefined) {
          s.statusDetails = { message: step.message };
        }
      });
      for (const attachment of step.attachments) {
        writeMappedAttachment(rootUuid, stepUuid, attachment);
      }
      writeChildSteps(rootUuid, step.childSteps, stepUuid);
      runtime.stopStep(stepUuid, { stop: step.stopMs });
    }
  }

  function writeMappedScenarioTest(
    scopeUuid: string,
    fullName: string,
    titlePath: readonly string[],
    mapped: MappedScenarioTest,
  ): void {
    const environmentLabels = getEnvironmentLabels().map((label) => ({
      name: label.name,
      value: redactString(label.value, options.secrets),
    }));

    const partialTest: Partial<TestResult> = {
      name: mapped.name,
      fullName,
      titlePath: [...titlePath],
      status: allureStatus(mapped.status),
      description: mapped.description,
      start: mapped.startMs,
      labels: [
        getLanguageLabel(),
        getFrameworkLabel("nukadoko"),
        getHostLabel(),
        getThreadLabel(),
        ...mapped.labels,
        ...environmentLabels,
      ],
      links: mapped.links,
      parameters: mapped.parameters,
      // Allure 2's own categories matching reads `error.message`/
      // `statusDetails.message` at the *test* level — map-scenario.ts's own
      // `firstFailure` is what feeds this. `trace` carries the same
      // failure's own raw, unmarked text (map-scenario.ts's own
      // `MappedGwtStepOutcome.failure` header) — a detail pane distinct
      // from `message`'s marked summary, never a replacement for it.
      ...(mapped.message !== undefined
        ? { statusDetails: { message: mapped.message, ...(mapped.trace !== undefined ? { trace: mapped.trace } : {}) } }
        : {}),
      // `testCaseId`/`historyId` are deliberately left unset here: the SDK's
      // own `stopTest` fills both in from `fullName` (plus every
      // non-excluded parameter) the moment it runs, below — no reason to
      // reimplement that formula here (map-scenario.ts's own header).
    };

    const testUuid = runtime.startTest(partialTest, [scopeUuid]);

    for (const attachment of mapped.attachments) {
      writeMappedAttachment(testUuid, null, attachment);
    }
    writeGwtSteps(testUuid, mapped.steps);

    runtime.stopTest(testUuid, { stop: mapped.stopMs });
    runtime.writeTest(testUuid);
  }

  /** Builds and writes one progress snapshot straight through `writer`,
   * bypassing `ReporterRuntime` entirely — `startTest`/`stopTest`/
   * `writeTest` all mutate that runtime's own internal bookkeeping (its own
   * scope/test state, this file's own header), which a result that
   * `ReporterRuntime` never itself started or means to keep tracking must
   * never touch. `createTestResult`/`createStepResult` (allure-js-commons'
   * own factory functions, the same ones `ReporterRuntime.startTest`/
   * `startStep` call internally) are what give this snapshot the exact
   * same `statusDetails: {}, stage: "pending"` shape a real, still-running
   * result already has at this same point in its own lifecycle. */
  function writeProgressSnapshot(pickle: Pickle, gherkinDocument: GherkinDocument, relativeFeaturePath: string): void {
    if (progressAnchorMs === null) {
      return;
    }
    const posixPath = toPosixPath(relativeFeaturePath);
    const featureName = gherkinDocument.feature?.name ?? "";

    const result = createTestResult(randomUuid());
    result.name = pickle.name;
    result.fullName = buildFullName(projectName, posixPath, pickle.name);
    result.titlePath = buildTitlePath(projectName, posixPath, featureName);
    result.start = progressAnchorMs;
    // Identity only (req 2's own invariant) — `mapScenario`'s own context
    // parameters (environment/session/target_version) are excluded from
    // historyId already, so a snapshot that never carries them changes
    // nothing a reader could compare against the real result.
    result.parameters = [
      ...buildExampleParameters(gherkinDocument, pickle),
      { name: "nukadoko.scenario.steps", value: buildScenarioStepsSignature(pickle), mode: "hidden" },
    ];
    // The exact same allure-js-commons helpers `ReporterRuntime.stopTest`
    // itself calls for the real result (map-scenario.ts's own header) —
    // called explicitly here because a snapshot never reaches `stopTest`
    // at all (this function's own doc comment).
    result.testCaseId = getTestResultTestCaseId(result);
    result.historyId = getTestResultHistoryId(result);

    result.steps = pickle.steps.map((pickleStep, index) => {
      const outcome = bufferedSteps[index];
      return outcome !== undefined
        ? mappedGwtStepToSnapshotStep(outcome.step)
        : plannedSnapshotStep(buildStepName(gherkinDocument, pickle, index, pickleStep.text));
    });

    // `hooks: []` — a hook's own outcome is never known mid-scenario, only
    // once `endScenario` maps `record.hooks` (this file's own header).
    const classifiedFailure = firstFailure(bufferedSteps, []);
    if (classifiedFailure !== undefined) {
      result.statusDetails = { message: classifiedFailure.message, trace: classifiedFailure.rawMessage };
    }

    writer.writeProgressSnapshot(result);
    progressUuids.push(result.uuid);
  }

  function emitFixture(scopeUuid: string, hook: MappedHook, declaredParameters: readonly MappedParameter[]): void {
    const fixtureUuid = runtime.startFixture(scopeUuid, hook.type, { name: hook.name, start: hook.startMs });
    if (fixtureUuid === undefined) {
      return;
    }
    runtime.updateFixture(fixtureUuid, (f) => {
      f.status = allureStatus(hook.status);
      if (hook.message !== undefined) {
        f.statusDetails = { message: hook.message };
      }
      if (declaredParameters.length > 0) {
        f.parameters = [...f.parameters, ...declaredParameters];
      }
    });
    for (const attachment of hook.attachments) {
      writeMappedAttachment(fixtureUuid, null, attachment);
    }
    writeChildSteps(fixtureUuid, hook.childSteps, null);
    runtime.stopFixture(fixtureUuid, { stop: hook.stopMs });
  }

  return {
    begin(): void {
      // Measurement must never break execution — the same principle every
      // method below already follows.
      try {
        runtime.writeCategoriesDefinitions();
        runtime.writeEnvironmentInfo();
        // Crash-abandoned progress files from a previous run — this run's
        // own `beginScenario` calls are what will write fresh ones (this
        // file's own header). Never touches a real `*-result.json`.
        writer.cleanProgressSnapshots();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(`warning: allure begin failed: ${message}\n`);
      }
    },

    beginScenario(input: BeginScenarioInput): void {
      bufferedSteps = [];
      progressUuids = [];
      progressAnchorMs = null;
      try {
        currentScopeUuid = runtime.startScope();
      } catch (error) {
        currentScopeUuid = null;
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(`warning: allure beginScenario failed: ${message}\n`);
      }
      if (currentScopeUuid === null) {
        return;
      }
      // Frozen once, for every progress snapshot this scenario will ever
      // write (`BeginScenarioInput.startedAt`'s own doc comment).
      progressAnchorMs = input.startedAt.getTime() - 1;
      try {
        writeProgressSnapshot(input.pickle, input.gherkinDocument, input.relativeFeaturePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(`warning: allure beginScenario snapshot failed: ${message}\n`);
      }
    },

    emitStep(input: EmitStepInput): void {
      // Captured into a local so TypeScript's own narrowing survives the
      // calls below (`currentScopeUuid` is an outer `let`, reassigned by
      // `beginScenario`/`endScenario`, so a bare null check on it doesn't
      // narrow across a function call the way a local `const` does).
      const scopeUuid = currentScopeUuid;
      if (scopeUuid === null) {
        // `beginScenario` never ran or itself failed — nothing to buffer
        // this step's own entry under. Already warned there; silent here so
        // one failed scenario doesn't repeat the same warning once per
        // step.
        return;
      }
      try {
        const outcome = mapGwtStep({
          index: input.index,
          record: input.record,
          stepRecord: input.stepRecord,
          finishedAt: input.finishedAt,
          gherkinDocument: input.gherkinDocument,
          pickle: input.pickle,
        });
        bufferedSteps.push(outcome);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(
          `warning: allure emitStep failed for scenario ${input.scenarioId} step ${input.index}: ${message}\n`,
        );
        // A minimal fallback entry, not a skipped one: every element of
        // `record.steps` needs exactly one `steps[]` entry, in order, or
        // every later step's own position silently shifts, misaligning the
        // report against the feature file that named them.
        const t = input.finishedAt.getTime();
        bufferedSteps.push({
          step: {
            name: input.record.text,
            status: "broken",
            message,
            startMs: t,
            stopMs: t,
            attachments: [],
            parameters: [],
            childSteps: [],
          },
          declaredLabels: [],
          declaredLinks: [],
        });
      }
      try {
        writeProgressSnapshot(input.pickle, input.gherkinDocument, input.relativeFeaturePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(
          `warning: allure progress snapshot failed for scenario ${input.scenarioId} step ${input.index}: ${message}\n`,
        );
      }
    },

    endScenario(input: EndScenarioInput): void {
      const scopeUuid = currentScopeUuid;
      currentScopeUuid = null;
      const steps = bufferedSteps;
      bufferedSteps = [];
      const progressUuidsToClean = progressUuids;
      progressUuids = [];
      progressAnchorMs = null;

      if (scopeUuid !== null) {
        try {
          const { record, gherkinDocument, pickle, relativeFeaturePath } = input;
          const posixPath = toPosixPath(relativeFeaturePath);

          const mapped = mapScenario({ record, gherkinDocument, pickle, posixPath, projectName, steps });

          // Bare `pickle.name`: a scenario's own test has nothing to
          // disambiguate itself from within its own fullName the way a
          // step's own test used to disambiguate itself from its siblings
          // (identity.ts's own header).
          const fullName = buildFullName(projectName, posixPath, pickle.name);
          const titlePath = buildTitlePath(projectName, posixPath, mapped.featureName);

          writeMappedScenarioTest(scopeUuid, fullName, titlePath, mapped);

          const scenarioStartMs = Date.parse(record.started_at);
          const scenarioStopMs = Date.parse(record.finished_at);
          for (const entry of mapHooks(record, scenarioStartMs, scenarioStopMs)) {
            emitFixture(scopeUuid, entry.hook, entry.declaredParameters);
          }

          // Attachments before the container, always: every `writeAttachment`
          // call above (the test's own, and every fixture's own) and the
          // `writeTest` call already landed synchronously, so `writeScope`
          // below is the only thing left to write.
          runtime.writeScope(scopeUuid);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          options.stderr.write(
            `warning: allure endScenario failed for scenario ${input.record.scenario_record_id}: ${message}\n`,
          );
        }
      }

      // Runs regardless of whether the real result above wrote
      // successfully (or was ever started at all): every progress snapshot
      // this scenario wrote is stale the moment `endScenario` is called,
      // real result or not, since nothing will ever `emitStep` into this
      // scenario's own buffer again. Isolated in its own try/catch per
      // uuid so one file this writer somehow can't remove never masks
      // (or is masked by) the real result's own success/failure above.
      for (const uuid of progressUuidsToClean) {
        try {
          writer.deleteProgressSnapshot(uuid);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          options.stderr.write(
            `warning: allure progress cleanup failed for scenario ${input.record.scenario_record_id}: ${message}\n`,
          );
        }
      }
    },
  };
}
