import path from "node:path";
import { Stage, Status, type StepResult, type TestResult } from "allure-js-commons";
import type { Category, EnvironmentInfo } from "allure-js-commons/sdk";
import {
  ReporterRuntime,
  ensureSuiteLabels,
  getEnvironmentLabels,
  getFrameworkLabel,
  getHostLabel,
  getLanguageLabel,
  getTestResultTestCaseId,
  getThreadLabel,
  getWorstTestStepResult,
} from "allure-js-commons/sdk/reporter";
import type { GherkinDocument, Pickle } from "@cucumber/messages";
import type { WritableSink } from "../../cli/writable-sink.js";
import type { ScenarioRecord } from "../../run/record-types.js";
import { readReceiptsForRecord } from "../receipts.js";
import { redactString } from "../../secrets/redact.js";
import type { SecretSet } from "../../secrets/types.js";
import { buildCategories } from "./categories.js";
import { buildFullName, resolveProjectName, toPosixPath } from "./identity.js";
import { mapScenario, type MappedAttachment, type MappedChildStep, type MappedStatus } from "./map-scenario.js";
import { createAtomicWriter } from "./writer.js";

// Responsibility: the thin layer that turns map-scenario.ts's flat
// description into actual `ReporterRuntime` calls (this task's spec,
// decision 2) — the only module in this directory that imports
// allure-js-commons for its running behavior (categories.ts/writer.ts also
// import it, but only for static Category/Writer plumbing) and the only one
// that touches the filesystem beyond what the `Writer` itself does
// (resolving the project name, reading each step's own receipt.json).
//
// Known limit: record.json carries no per-hook timestamp of its own, so
// every before-hook collapses to the scenario's own `started_at` and every
// after-hook to its `finished_at`, both zero-width — a hook's own duration
// is not observable through this mapping today. Widening record.json to
// carry it is a decision for outside this task (this task's spec: leaving
// the schema unchanged takes priority).
//
// AllureEmitterOptions carries no `stateDir` of its own (this task's spec,
// decision 12 pins its exact shape): `readReceiptsForRecord`
// (src/report/receipts.ts, m3c-messages-emitter task spec, decision 2 —
// pulled up from this file's own `receiptsForRecord`, now shared with
// src/report/messages/emitter.ts) derives a step's receipt directory from
// `record.evidence.dir` instead, keeping decision 12's own interface
// untouched.

export interface AllureEmitterOptions {
  /** Absolute path. */
  readonly resultsDir: string;
  readonly rootDir: string;
  readonly environment: string;
  readonly targetVersion?: string;
  readonly secrets: SecretSet;
  readonly stderr: WritableSink;
}

export interface EmitScenarioInput {
  readonly record: ScenarioRecord;
  readonly gherkinDocument: GherkinDocument;
  readonly pickle: Pickle;
  readonly relativeFeaturePath: string;
}

export interface AllureEmitter {
  /** Writes categories.json and environment.properties. Once, at the start
   * of a run. */
  begin(): void;
  /** Emits one scenario. Never throws (this task's spec, decision 11). */
  emitScenario(input: EmitScenarioInput): void;
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

/** A minimal, valid `StepResult` carrying only the one field
 * `getWorstTestStepResult` actually reads (`.status`) — used to fold hook
 * outcomes into the same worst-of computation as the real step results
 * without allure-js-commons ever seeing our steps and hooks as anything
 * other than what they really are (hooks are still emitted as fixtures, not
 * steps; this stub never leaves this function). */
function stepResultStub(status: Status): StepResult {
  return { status, statusDetails: {}, stage: Stage.FINISHED, steps: [], attachments: [], parameters: [] };
}

export function createAllureEmitter(options: AllureEmitterOptions): AllureEmitter {
  const projectName = resolveProjectName(options.rootDir);
  const writer = createAtomicWriter(options.resultsDir);
  const environmentInfo: EnvironmentInfo = {
    environment: options.environment,
    // `target_version` is a run-level value (this task's spec, decision 9):
    // unlike record.json/receipt.json, nothing has redacted it yet.
    ...(options.targetVersion !== undefined
      ? { target_version: redactString(options.targetVersion, options.secrets) }
      : {}),
  };
  const categories: Category[] = buildCategories();
  const runtime = new ReporterRuntime({ writer, categories, environmentInfo });

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

  // `declared.logs` becomes a zero-width child step at the parent's own
  // start (this task's spec, decision 7) — the same shape the allure facade's
  // own `logStep` produces, without importing the facade itself (this
  // emitter drives `ReporterRuntime` directly).
  function writeChildSteps(
    rootUuid: string,
    parentStepUuid: string | null,
    childSteps: readonly MappedChildStep[],
    timestampMs: number,
  ): void {
    for (const child of childSteps) {
      const uuid = runtime.startStep(rootUuid, parentStepUuid, { name: child.name, start: timestampMs });
      if (uuid !== undefined) {
        runtime.updateStep(uuid, (s) => {
          s.status = Status.PASSED;
        });
        runtime.stopStep(uuid, { stop: timestampMs });
      }
    }
  }

  return {
    begin(): void {
      // Measurement must never break execution (this task's spec, decision
      // 11) — the same principle emitScenario's own try/catch below already
      // follows, extended here since a categories.json/environment.properties
      // write failure would otherwise take `nuka run` itself down with it.
      try {
        runtime.writeCategoriesDefinitions();
        runtime.writeEnvironmentInfo();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(`warning: allure begin failed: ${message}\n`);
      }
    },

    emitScenario(input: EmitScenarioInput): void {
      try {
        const { record, gherkinDocument, pickle, relativeFeaturePath } = input;
        const posixPath = toPosixPath(relativeFeaturePath);
        const receipts = readReceiptsForRecord(options.rootDir, record);
        const mapped = mapScenario({ record, receipts, gherkinDocument, pickle, posixPath });

        // The scenario's own overall status is the worst of every step and
        // every hook (this task's spec, decision 3) — computed with the
        // official `getWorstTestStepResult` up front, before any of the
        // runtime's own state exists, since every input it needs
        // (`mapped.steps`/`mapped.hooks`) is already fully resolved.
        const finalStatus =
          getWorstTestStepResult([
            ...mapped.steps.map((step) => stepResultStub(allureStatus(step.status))),
            ...mapped.hooks.map((hook) => stepResultStub(allureStatus(hook.status))),
          ])?.status ?? Status.PASSED;

        const scopeUuid = runtime.startScope();

        for (const hook of mapped.hooks) {
          const fixtureUuid = runtime.startFixture(scopeUuid, hook.type, { name: hook.name, start: hook.startMs });
          if (fixtureUuid === undefined) {
            continue;
          }
          runtime.updateFixture(fixtureUuid, (f) => {
            f.status = allureStatus(hook.status);
            if (hook.message !== undefined) {
              f.statusDetails = { message: hook.message };
            }
          });
          for (const attachment of hook.attachments) {
            writeMappedAttachment(fixtureUuid, null, attachment);
          }
          writeChildSteps(fixtureUuid, null, hook.childSteps, hook.startMs);
          runtime.stopFixture(fixtureUuid, { stop: hook.stopMs });
        }

        const templateFullName = buildFullName(projectName, posixPath, mapped.test.templateName);
        const fullName = buildFullName(projectName, posixPath, mapped.test.name);
        const testCaseId = getTestResultTestCaseId({ fullName: templateFullName } as TestResult);

        const environmentLabels = getEnvironmentLabels().map((label) => ({
          name: label.name,
          value: redactString(label.value, options.secrets),
        }));

        const partialTest: Partial<TestResult> = {
          name: mapped.test.name,
          fullName,
          testCaseId,
          status: finalStatus,
          description: mapped.test.description,
          start: mapped.test.startMs,
          labels: [
            getLanguageLabel(),
            getFrameworkLabel("nukadoko"),
            getHostLabel(),
            getThreadLabel(),
            ...mapped.test.labels,
            ...environmentLabels,
          ],
          links: mapped.test.links,
          parameters: mapped.test.parameters,
          // Allure 2's own categories matching reads `error.message`/
          // `statusDetails.message` at the *test* level, never a step's
          // (verified against the real @allurereport/plugin-classic source)
          // — without this, the categories.json rules this emitter
          // also writes can never match anything, no matter how correct
          // their own regexes are (this task's spec, M3-C item 1).
          ...(mapped.test.message !== undefined ? { statusDetails: { message: mapped.test.message } } : {}),
        };
        // Mutates `partialTest.labels` in place, appending suite labels only
        // when none are already present (this task's spec, decision 6: pin
        // the test to whichever labels actually come back).
        ensureSuiteLabels(partialTest, [mapped.test.featureName]);

        const testUuid = runtime.startTest(partialTest, [scopeUuid]);

        for (const attachment of mapped.test.attachments) {
          writeMappedAttachment(testUuid, null, attachment);
        }

        for (const step of mapped.steps) {
          const stepUuid = runtime.startStep(testUuid, undefined, { name: step.name, start: step.startMs });
          if (stepUuid === undefined) {
            continue;
          }
          runtime.updateStep(stepUuid, (s) => {
            s.status = allureStatus(step.status);
            s.parameters = [...step.parameters];
            if (step.message !== undefined) {
              s.statusDetails = { message: step.message };
            }
          });
          for (const attachment of step.attachments) {
            writeMappedAttachment(testUuid, stepUuid, attachment);
          }
          writeChildSteps(testUuid, stepUuid, step.childSteps, step.startMs);
          runtime.stopStep(stepUuid, { stop: step.stopMs });
        }

        // Attachments before result, always (this task's spec, decision 10):
        // every `writeAttachment` call above already landed synchronously,
        // so `writeTest`/`writeScope` below are the only things left to
        // write.
        runtime.stopTest(testUuid, { stop: mapped.test.stopMs });
        runtime.writeTest(testUuid);
        runtime.writeScope(scopeUuid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(
          `warning: allure emit failed for scenario ${input.record.scenario_id}: ${message}\n`,
        );
      }
    },
  };
}
