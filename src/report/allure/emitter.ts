import path from "node:path";
import { Status, type TestResult } from "allure-js-commons";
import type { Category, EnvironmentInfo } from "allure-js-commons/sdk";
import {
  ReporterRuntime,
  ensureSuiteLabels,
  getEnvironmentLabels,
  getFrameworkLabel,
  getHostLabel,
  getLanguageLabel,
  getThreadLabel,
} from "allure-js-commons/sdk/reporter";
import type { GherkinDocument, Pickle } from "@cucumber/messages";
import type { WritableSink } from "../../cli/writable-sink.js";
import type { StepRecord } from "../../record/types.js";
import type { ScenarioRecord, ScenarioStepRecord } from "../../run/record-types.js";
import { redactString } from "../../secrets/redact.js";
import type { SecretSet } from "../../secrets/types.js";
import { buildCategories } from "./categories.js";
import { buildFullName, resolveProjectName, toPosixPath } from "./identity.js";
import {
  mapHooks,
  mapScenario,
  mapScenarioEvidence,
  mapStep,
  type MappedAttachment,
  type MappedChildStep,
  type MappedHook,
  type MappedParameter,
  type MappedStatus,
  type MappedStepTest,
} from "./map-scenario.js";
import { createAtomicWriter } from "./writer.js";

// Responsibility: the thin layer that turns map-scenario.ts's flat
// description into actual `ReporterRuntime` calls — the only module in this
// directory that imports allure-js-commons for its running behavior
// (categories.ts/writer.ts also import it, but only for static Category/
// Writer plumbing) and the only one that touches the filesystem beyond what
// the `Writer` itself does (resolving the project name).
//
// Three calls per pickle, not one: `beginScenario` opens this scenario's own
// Allure *scope* before its first step runs; `emitStep` writes one step's
// own *test* to disk the moment that step finishes — never batched to
// scenario end, which is the entire point of writing per step rather than
// per scenario — reading it straight off `ReporterRuntime.startTest`/
// `writeTest`, which write on call, not on some later flush; `endScenario`
// writes one more test for the scenario as a whole (map-scenario.ts's own
// `mapScenario`), maps this scenario's own hooks into fixtures under that
// same scope, adds a synthetic fixture for whatever browser evidence
// belongs to the scenario as a whole (map-scenario.ts's own
// `mapScenarioEvidence`), and only then writes the scope's own container
// (`writeScope`) — a hook is always mapped once the whole scenario is over,
// not per step, unlike a step's own test; the scenario's own test is
// written there for the same reason (record.json's own `status`, `steps`,
// and `finished_at` are only complete once the scenario is over). This
// module holds exactly one piece of state across those three calls,
// `currentScopeUuid` — safe because `nuka run` executes scenarios strictly
// sequentially, never two at once.
//
// A Before hook's own failure still leaves every step it stops from ever
// running reported `"skipped"`, never `"failed"` — the failure itself is
// visible in that Before fixture's own detail view (unaffected by the
// scenario-level test below). Unlike a step's own test, though, the
// scenario-level test's own status is `record.status` directly, which the
// scenario record already sets to `"failed"` whenever any of its steps
// didn't pass (record-types.ts) — a Before hook stopping every step still
// turns the scenario-level test red, closing most of the display gap the
// step = test redesign opened (docs/spec.md "Allure emitter"): the suite
// tree's own group status already read correctly at the `suite` level for
// this case; now the scenario's own test does too, even though every step
// beneath it still reads `"skipped"`.
//
// Known limit: record.json carries no per-hook timestamp of its own, so
// every before-hook collapses to the
// scenario's own `started_at` and every after-hook to its `finished_at`,
// both zero-width (map-scenario.ts's own `mapHooks`).
//
// AllureEmitterOptions carries no `stateDir` of its own: a step's own step
// record
// is handed to `emitStep` directly by the caller (cli/run.ts, threaded from
// run-scenario.ts's own `onStepFinished`) — this emitter never reads a
// record.json off disk itself any more, unlike the messages emitter
// (src/report/messages/emitter.ts), which still does via
// src/report/step-records.ts's `readStepRecordsForScenario`.

export interface AllureEmitterOptions {
  /** Absolute path. */
  readonly resultsDir: string;
  readonly rootDir: string;
  readonly environment: string;
  readonly targetVersion?: string;
  readonly secrets: SecretSet;
  readonly stderr: WritableSink;
}

export interface EmitStepInput {
  readonly runId: string;
  readonly scenarioId: string;
  readonly environment: string;
  readonly session: string | null;
  readonly targetVersion?: string;
  readonly record: ScenarioStepRecord;
  /** The exact in-memory object run-scenario.ts's own `writeStepRecord`
   * call
   * just persisted for this step, or `null` for a step with no step record
   * of its own at all — see map-scenario.ts's `MapStepInput.stepRecord` for
   * the
   * full reasoning. */
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
  /** Writes categories.json and environment.properties. Once, at the start
   * of a run. */
  begin(): void;
  /** Opens this scenario's own scope, before its first step runs. Never
   * throws. */
  beginScenario(): void;
  /** Writes one step's own test, the moment that step finishes. Never
   * throws. */
  emitStep(input: EmitStepInput): void;
  /** Maps this scenario's own hooks (and whatever scenario-level evidence it
   * collected) into fixtures under the scope `beginScenario` opened, then
   * writes that scope. Never throws. */
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
  // time (this file's own header). Both are `null` both before the first
  // `beginScenario` and once `endScenario` has cleared them, so a stray
  // `emitStep` call outside a scenario's own begin/end pair is a no-op
  // rather than attaching to the *previous* scenario's own scope or
  // classification.
  let currentScopeUuid: string | null = null;
  // The first step this scenario ran whose own failure resolved to a
  // classified `ErrorKind` (mapStep's own `nukadoko.failure` label — a
  // vocabulary defect like "undefined"/"ambiguous" never gets one, the same
  // as it never did at step grain). `endScenario` reads this to give the
  // scenario-level test itself a `nukadoko.failure` label and message when
  // the scenario failed, the same "mark the first failure" the old
  // scenario = test design used before step = test replaced it (this
  // file's own header) — revived here only for this one rollup test, never
  // for a step's own test, which still carries its own precise
  // classification unaffected. Without this, every failing scenario's own
  // test would fall into Allure 3's built-in, uninformative "Product
  // errors" catch-all instead of one of `nuka init`'s own seven categories,
  // even though every step under it is already correctly classified.
  let firstFailure: { readonly kind: string; readonly message: string } | null = null;

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

  // Every child step nests directly under `rootUuid` now (`parentStepUuid`
  // is always `null` at both call sites below) — one level shallower than
  // when a step was itself a child of the scenario's own test. Verified
  // this still works: parameters and errors are still preserved, and the
  // lost nesting level is carried by Allure's own breadcrumb instead.
  function writeChildSteps(rootUuid: string, childSteps: readonly MappedChildStep[]): void {
    for (const child of childSteps) {
      const uuid = runtime.startStep(rootUuid, null, { name: child.name, start: child.startMs });
      if (uuid !== undefined) {
        runtime.updateStep(uuid, (s) => {
          s.status = allureStatus(child.status);
        });
        runtime.stopStep(uuid, { stop: child.stopMs });
      }
    }
  }

  // Shared by `emitStep` and `endScenario`'s own scenario-level test below:
  // both start from a `MappedStepTest` (map-scenario.ts's own shared shape,
  // one per step or one per scenario) and need the exact same `TestResult`
  // fields built from it — keeping this in one place is what keeps a field
  // (`statusDetails.message`, say) from being wired up for one grain and
  // quietly forgotten for the other.
  function writeMappedTest(
    scopeUuid: string,
    fullName: string,
    suitePath: readonly [string, string],
    mapped: MappedStepTest,
  ): void {
    const environmentLabels = getEnvironmentLabels().map((label) => ({
      name: label.name,
      value: redactString(label.value, options.secrets),
    }));

    const partialTest: Partial<TestResult> = {
      name: mapped.name,
      fullName,
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
      // `statusDetails.message` at the *test* level — every failing step
      // has its own test to carry it (map-scenario.ts's own `mapStep`).
      // `mapScenario`'s own tests carry one too, but only the first
      // classified failure's own (this file's own `firstFailure`), since a
      // scenario's own test has no single step's outcome of its own to
      // report.
      ...(mapped.message !== undefined ? { statusDetails: { message: mapped.message } } : {}),
      // `testCaseId`/`historyId` are deliberately left unset here: the SDK's
      // own `stopTest` fills both in from `fullName` (plus every
      // non-excluded parameter) the moment it runs, below — no reason to
      // reimplement that formula here (map-scenario.ts's own header).
    };
    // Mutates `partialTest.labels` in place, appending suite labels only
    // when none are already present. `[featureName, scenario name]` fills
    // both `parentSuite` and `suite` for a step's own test and a scenario's
    // own test alike — the same pair, so both grains sit in the same suite
    // group in the report's own tree.
    ensureSuiteLabels(partialTest, suitePath);

    const testUuid = runtime.startTest(partialTest, [scopeUuid]);

    for (const attachment of mapped.attachments) {
      writeMappedAttachment(testUuid, null, attachment);
    }
    writeChildSteps(testUuid, mapped.childSteps);

    runtime.stopTest(testUuid, { stop: mapped.stopMs });
    runtime.writeTest(testUuid);
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
    writeChildSteps(fixtureUuid, hook.childSteps);
    runtime.stopFixture(fixtureUuid, { stop: hook.stopMs });
  }

  return {
    begin(): void {
      // Measurement must never break execution — the same principle every
      // method below already follows.
      try {
        runtime.writeCategoriesDefinitions();
        runtime.writeEnvironmentInfo();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(`warning: allure begin failed: ${message}\n`);
      }
    },

    beginScenario(): void {
      firstFailure = null;
      try {
        currentScopeUuid = runtime.startScope();
      } catch (error) {
        currentScopeUuid = null;
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(`warning: allure beginScenario failed: ${message}\n`);
      }
    },

    emitStep(input: EmitStepInput): void {
      // Captured into a local so TypeScript's own narrowing survives the
      // calls below (`currentScopeUuid` is an outer `let`, reassigned by
      // `beginScenario`/`endScenario`, so a bare null check on it doesn't
      // narrow across a function call the way a local `const` does).
      const scopeUuid = currentScopeUuid;
      if (scopeUuid === null) {
        // `beginScenario` never ran or itself failed — nothing to attach
        // this step's own test to. Already warned there; silent here so one
        // failed scenario doesn't repeat the same warning once per step.
        return;
      }
      try {
        const posixPath = toPosixPath(input.relativeFeaturePath);
        const mapped = mapStep({
          runId: input.runId,
          scenarioId: input.scenarioId,
          environment: input.environment,
          session: input.session,
          targetVersion: input.targetVersion,
          record: input.record,
          stepRecord: input.stepRecord,
          index: input.index,
          finishedAt: input.finishedAt,
          gherkinDocument: input.gherkinDocument,
          pickle: input.pickle,
          posixPath,
        });

        if (firstFailure === null) {
          const kindLabel = mapped.labels.find((label) => label.name === "nukadoko.failure");
          if (kindLabel !== undefined && mapped.message !== undefined) {
            // `mapped.message` is already `[nukadoko.failure=<kind>] ...`
            // (map-scenario.ts's own `markedMessage`) whenever `kindLabel`
            // is present, so this is a straight capture, never a second
            // marker-formatting call.
            firstFailure = { kind: kindLabel.value, message: mapped.message };
          }
        }

        // `{project}:{featurePath}#{scenario}#{step text}` — a
        // human-readable identifier, unlike historyId
        // (this module's own header, and map-scenario.ts's own header for
        // why historyId is deliberately left to fall apart instead).
        const fullName = buildFullName(projectName, posixPath, `${input.pickle.name}#${mapped.name}`);

        writeMappedTest(scopeUuid, fullName, [mapped.featureName, input.pickle.name], mapped);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(
          `warning: allure emitStep failed for scenario ${input.scenarioId} step ${input.index}: ${message}\n`,
        );
      }
    },

    endScenario(input: EndScenarioInput): void {
      const scopeUuid = currentScopeUuid;
      currentScopeUuid = null;
      const scenarioFirstFailure = firstFailure;
      firstFailure = null;
      if (scopeUuid === null) {
        return;
      }
      try {
        const { record, gherkinDocument, pickle, relativeFeaturePath } = input;
        const scenarioStartMs = Date.parse(record.started_at);
        const scenarioStopMs = Date.parse(record.finished_at);

        const posixPath = toPosixPath(relativeFeaturePath);
        const mappedScenario = mapScenario({
          record,
          gherkinDocument,
          pickle,
          environment: record.environment,
          session: record.session,
          targetVersion: record.target_version,
          posixPath,
          firstFailure: scenarioFirstFailure ?? undefined,
        });
        // Bare `pickle.name`, never `${pickle.name}#...` — a scenario's own
        // test has nothing to disambiguate itself from within its own
        // fullName the way a step's own test disambiguates itself from its
        // siblings (identity.ts's own header).
        const scenarioFullName = buildFullName(projectName, posixPath, pickle.name);
        writeMappedTest(scopeUuid, scenarioFullName, [mappedScenario.featureName, pickle.name], mappedScenario);

        for (const entry of mapHooks(record, scenarioStartMs, scenarioStopMs)) {
          emitFixture(scopeUuid, entry.hook, entry.declaredParameters);
        }

        const evidenceFixture = mapScenarioEvidence(record);
        if (evidenceFixture !== undefined) {
          emitFixture(scopeUuid, evidenceFixture, []);
        }

        // Attachments before the container, always: every `writeAttachment`
        // call above (fixtures) and every `writeTest` call (`emitStep`,
        // already done by the time this runs) already landed synchronously,
        // so `writeScope` below is the only thing left to write.
        runtime.writeScope(scopeUuid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(
          `warning: allure endScenario failed for scenario ${input.record.scenario_record_id}: ${message}\n`,
        );
      }
    },
  };
}
