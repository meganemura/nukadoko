import type { TestResult } from "allure-js-commons";
import { Status } from "allure-js-commons";
import type { Category, EnvironmentInfo } from "allure-js-commons/sdk";
import {
  ReporterRuntime,
  getEnvironmentLabels,
  getFrameworkLabel,
  getLanguageLabel,
} from "allure-js-commons/sdk/reporter";
import type { GherkinDocument, Pickle } from "@cucumber/messages";
import type { StepRecord } from "../../record/types.js";
import type { ScenarioRecord } from "../../record/scenario-record.js";
import { buildCategories } from "./categories.js";
import { buildFullName, buildTitlePath, toPosixPath } from "./identity.js";
import {
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
import { createAtomicWriter, stableNames } from "./writer.js";
import { ownStepSpan } from "../step-timeline.js";
import type { ScenarioVerdict } from "../scenario-verdict.js";

// Responsibility: the thin layer that turns map-scenario.ts's flat
// description of one finished scenario into `ReporterRuntime` calls, for
// `nuka report --format allure`. It is the only module in this directory
// that imports allure-js-commons for its running behavior (categories.ts
// and writer.ts import it only for static Category and Writer plumbing).
// It reads nothing itself: the caller hands it each scenario's record, its
// step records, and the Gherkin document the run parsed, and a function
// that says where a path a record names is on disk.
//
// One scenario, one Allure test result, with one `steps[]` entry per
// element of `record.steps`, in order, with no gaps: a step that never ran
// a body (skipped by an earlier failure, never began) still gets its entry,
// so every later step keeps its position against the feature file that
// named it. The scenario's hooks become fixtures under the same scope, and
// the scope's own container is written last.
//
// Identity is the one results written during a run used, unchanged: `fullName` is
// `<project>:<feature path>#<scenario name>`, and the parameters are the
// Examples row, the hidden step-text signature, and the environment.
// `testCaseId` and `historyId` are left to `ReporterRuntime.stopTest`, which
// computes both from those with allure-js-commons' own formula, so a result
// rendered now lands on the same history as one written during a run of
// an earlier version.
//
// A step that fails to map costs that step a minimal `broken` entry; a
// failure past that point costs the scenario its result, never the other
// scenarios: each one is written inside its own try, and the failure is
// reported through `warn`. The records on disk are the source of truth
// either way.
//
// Known limit: record.json carries no per-hook timestamp of its own, so
// every before-hook collapses to the scenario's own `started_at` and every
// after-hook to its `finished_at`, both zero-width (map-scenario.ts's own
// `mapHooks`).

export interface AllureScenarioInput {
  readonly record: ScenarioRecord;
  /** Each step record the scenario's steps name, by id; `null` for one
   * that could not be read. */
  readonly stepRecords: ReadonlyMap<string, StepRecord | null>;
  readonly gherkinDocument: GherkinDocument;
  readonly pickle: Pickle;
  /** The feature file's path relative to the project root. */
  readonly relativeFeaturePath: string;
  /** What the verdict table says of this execution (src/report/scenario-verdict.ts). */
  readonly verdict?: ScenarioVerdict | undefined;
}

export interface WriteAllureResultsOptions {
  /** Absolute path. Created when missing. */
  readonly resultsDir: string;
  /** The host project's package.json name as the run recorded it. */
  readonly projectName: string | null;
  /** Every environment of the run, for environment.properties. */
  readonly environment: string;
  /** Written only when one environment ran, since it belongs to that one
   * target. */
  readonly targetVersion?: string;
  /** Where a path a record names is on disk. */
  readonly resolvePath: (recordedPath: string) => string;
  /** Called with each result, container, and attachment file written. */
  readonly onWrite?: (absolutePath: string) => void;
  readonly warn: (message: string) => void;
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

export function writeAllureResults(options: WriteAllureResultsOptions, scenarios: readonly AllureScenarioInput[]): void {
  const writer = stableNames(
    createAtomicWriter(options.resultsDir, {
      ...(options.onWrite !== undefined ? { onWrite: options.onWrite } : {}),
    }),
  );
  const environmentInfo: EnvironmentInfo = {
    environment: options.environment,
    ...(options.targetVersion !== undefined ? { target_version: options.targetVersion } : {}),
  };
  const categories: Category[] = buildCategories();
  const runtime = new ReporterRuntime({ writer, categories, environmentInfo });
  // A file shared by every render that cannot be written costs that file
  // only; each scenario's result does not depend on it.
  try {
    runtime.writeCategoriesDefinitions();
    runtime.writeEnvironmentInfo();
  } catch (error) {
    options.warn(`allure categories.json or environment.properties not written: ${error instanceof Error ? error.message : String(error)}`);
  }

  // An attachment that cannot be read, or whose path is refused, costs
  // that attachment only: the result is written without it.
  function writeMappedAttachment(rootUuid: string, parentStepUuid: string | null, attachment: MappedAttachment): void {
    if (attachment.kind === "path") {
      try {
        runtime.writeAttachment(rootUuid, parentStepUuid, attachment.name, options.resolvePath(attachment.path), {
          contentType: attachment.contentType,
          wrapInStep: false,
        });
      } catch (error) {
        options.warn(`allure: could not attach ${attachment.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
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
    // `ALLURE_LABEL_*` as the process rendering the report sees it: the
    // person rendering chooses those, the run did not record any.
    const environmentLabels = getEnvironmentLabels();

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

  function mapSteps(input: AllureScenarioInput): MappedGwtStepOutcome[] {
    const { record, stepRecords, gherkinDocument, pickle } = input;
    const steps: MappedGwtStepOutcome[] = [];
    for (const [index, entry] of record.steps.entries()) {
      const stepRecord = entry.step_record_id === null ? null : (stepRecords.get(entry.step_record_id) ?? null);
      const stepRecordUnreadable = entry.step_record_id !== null && stepRecords.has(entry.step_record_id) && stepRecord === null;
      const previousStopMs = steps.at(-1)?.step.stopMs ?? Date.parse(record.started_at);
      try {
        steps.push(mapGwtStep({ index, record: entry, stepRecord, stepRecordUnreadable, previousStopMs, gherkinDocument, pickle }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.warn(`allure: step ${index} of scenario ${record.scenario_record_id} was not mapped: ${message}`);
        const ownSpan = ownStepSpan(stepRecord);
        steps.push({
          step: {
            name: entry.text,
            status: "broken",
            message,
            ...(ownSpan ?? { startMs: previousStopMs, stopMs: previousStopMs }),
            attachments: [],
            parameters: [],
            childSteps: [],
          },
          ownSpan,
          declaredLabels: [],
          declaredLinks: [],
        });
      }
    }
    return steps;
  }

  for (const input of scenarios) {
    try {
      const { record, gherkinDocument, pickle, relativeFeaturePath } = input;
      // One scenario execution of one run: a second render of it writes
      // the same file names (writer.ts's `stableNames`).
      writer.begin(`${record.run_id}\u0000${record.scenario_record_id}\u0000${record.environment}`);
      const scopeUuid = runtime.startScope();
      const posixPath = toPosixPath(relativeFeaturePath);
      const projectName = options.projectName;
      const mapped = mapScenario({ record, gherkinDocument, pickle, posixPath, projectName, steps: mapSteps(input), verdict: input.verdict });
      // Bare `pickle.name`: a scenario's own test has nothing to
      // disambiguate itself from within its own fullName (identity.ts's
      // own header).
      const fullName = buildFullName(projectName, posixPath, pickle.name);
      const titlePath = buildTitlePath(projectName, posixPath, mapped.featureName);
      writeMappedScenarioTest(scopeUuid, fullName, titlePath, mapped);
      const scenarioStartMs = Date.parse(record.started_at);
      const scenarioStopMs = Date.parse(record.finished_at);
      for (const entry of mapHooks(record, scenarioStartMs, scenarioStopMs)) {
        emitFixture(scopeUuid, entry.hook, entry.declaredParameters);
      }
      // Every attachment and the test landed synchronously above, so the
      // container is the last file of the scenario.
      runtime.writeScope(scopeUuid);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.warn(`allure: scenario ${input.record.scenario_record_id} was not written: ${message}`);
    }
  }
}
