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
  mapScenarioEvidence,
  mapStep,
  type MappedAttachment,
  type MappedChildStep,
  type MappedHook,
  type MappedParameter,
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
// Three calls per pickle, not one: `beginScenario` opens this scenario's own
// Allure *scope* before its first step runs; `emitStep` writes one step's
// own *test* to disk the moment that step finishes — never batched to
// scenario end, which is the entire point of writing per step rather than
// per scenario — reading it straight off `ReporterRuntime.startTest`/
// `writeTest`, which write on call, not on some later flush; `endScenario`
// maps this scenario's own hooks into fixtures under that same scope, adds
// a synthetic fixture for whatever browser evidence belongs to the scenario
// as a whole (map-scenario.ts's own `mapScenarioEvidence`), and only then
// writes the scope's own container (`writeScope`) — a hook is always mapped
// once the whole scenario is over, not per step, unlike a step's own test.
// This module holds exactly one piece of state across those three
// calls, `currentScopeUuid` — safe because `nuka run` executes scenarios
// strictly sequentially, never two at once.
//
// A Before hook's own failure no longer turns any single Allure *test* red
// (it did, under the old scenario = test design, via a worst-of computation
// across every step and hook): every step it stops from ever running is
// reported `"skipped"`, and the failure itself is visible only inside that
// Before fixture's own detail view. The suite tree's own group status
// (docs/spec.md "Allure emitter") still reads correctly at the `suite`
// level for a step failing mid-scenario; a scenario that never got past its
// own Before hook is the one case this redesign reports less prominently
// than before. `nuka run`'s own exit code and the written `record.json` are
// both unaffected — this is a report-display regression only, accepted as
// part of the step = test trade-off, not something this file works around
// with a synthetic failing test.
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

  // The one piece of state this module carries across `beginScenario`/
  // `emitStep`/`endScenario` — safe only because `nuka run` runs one
  // scenario at a time (this file's own header). `null` both before the
  // first `beginScenario` and once `endScenario` has cleared it, so a stray
  // `emitStep` call outside a scenario's own begin/end pair is a no-op
  // rather than attaching to the *previous* scenario's own scope.
  let currentScopeUuid: string | null = null;

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

        // `{project}:{featurePath}#{scenario}#{step text}` — a
        // human-readable identifier, unlike historyId
        // (this module's own header, and map-scenario.ts's own header for
        // why historyId is deliberately left to fall apart instead).
        const fullName = buildFullName(projectName, posixPath, `${input.pickle.name}#${mapped.name}`);

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
          // `statusDetails.message` at the *test* level — every failing
          // step now has its own test to carry it (map-scenario.ts's own
          // `mapStep`), where the old scenario = test design could only
          // ever mark the scenario's first failure.
          ...(mapped.message !== undefined ? { statusDetails: { message: mapped.message } } : {}),
          // `testCaseId`/`historyId` are deliberately left unset here: the
          // SDK's own `stopTest` fills both in from `fullName` (plus every
          // non-excluded parameter, `mapped.parameters` already carrying
          // this test's own `nukadoko.run`/`nukadoko.scenario`/
          // `nukadoko.step` hidden ones) the moment it runs, below — no
          // reason to reimplement that formula here (map-scenario.ts's own
          // header).
        };
        // Mutates `partialTest.labels` in place, appending suite labels
        // only when none are already present. `[featureName, scenario
        // name]` fills both `parentSuite` and `suite` — the `suite` slot
        // was previously left empty (`ensureSuiteLabels` used to be called
        // with only `[featureName]`).
        ensureSuiteLabels(partialTest, [mapped.featureName, input.pickle.name]);

        const testUuid = runtime.startTest(partialTest, [scopeUuid]);

        for (const attachment of mapped.attachments) {
          writeMappedAttachment(testUuid, null, attachment);
        }
        writeChildSteps(testUuid, mapped.childSteps);

        runtime.stopTest(testUuid, { stop: mapped.stopMs });
        runtime.writeTest(testUuid);
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
      if (scopeUuid === null) {
        return;
      }
      try {
        const { record } = input;
        const scenarioStartMs = Date.parse(record.started_at);
        const scenarioStopMs = Date.parse(record.finished_at);

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
          `warning: allure endScenario failed for scenario ${input.record.scenario_id}: ${message}\n`,
        );
      }
    },
  };
}
