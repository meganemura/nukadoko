import path from "node:path";
import type { GherkinDocument, Pickle } from "@cucumber/messages";
import { resolveProjectName } from "../../src/report/allure/identity.js";
import { writeAllureResults } from "../../src/report/allure/write-results.js";
import type { ScenarioRecord, ScenarioStepEntry } from "../../src/record/scenario-record.js";
import type { StepRecord } from "../../src/record/types.js";

// Responsibility: a step-by-step way to hand one scenario to
// `writeAllureResults`, for tests that build a scenario's steps one at a
// time. `endScenario` writes what `emitStep` collected, through the same
// function `nuka report --format allure` calls; nothing here maps a step.

export interface ScenarioWriterOptions {
  readonly resultsDir: string;
  readonly rootDir: string;
  readonly environment: string;
  readonly targetVersion?: string;
  readonly stderr: { write(chunk: string): boolean };
}

export interface BeginScenarioInput {
  readonly pickle: Pickle;
  readonly gherkinDocument: GherkinDocument;
  readonly relativeFeaturePath: string;
  readonly environment: string;
  readonly startedAt: Date;
}

export interface EmitStepInput {
  readonly runId: string;
  readonly scenarioId: string;
  readonly environment: string;
  readonly record: ScenarioStepEntry;
  readonly stepRecord: StepRecord | null;
  readonly index: number;
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

export interface ScenarioWriter {
  begin(): void;
  beginScenario(input: BeginScenarioInput): void;
  emitStep(input: EmitStepInput): void;
  endScenario(input: EndScenarioInput): void;
}

export function createScenarioWriter(options: ScenarioWriterOptions): ScenarioWriter {
  const writeOptions = {
    resultsDir: options.resultsDir,
    projectName: resolveProjectName(options.rootDir),
    environment: options.environment,
    ...(options.targetVersion !== undefined ? { targetVersion: options.targetVersion } : {}),
    resolvePath: (recordedPath: string) => path.resolve(options.rootDir, recordedPath),
    warn: (message: string) => {
      options.stderr.write(`warning: ${message}\n`);
    },
  };
  let stepRecords = new Map<string, StepRecord | null>();
  return {
    begin(): void {
      writeAllureResults(writeOptions, []);
    },
    beginScenario(): void {
      stepRecords = new Map();
    },
    emitStep(input: EmitStepInput): void {
      if (input.record.step_record_id !== null) stepRecords.set(input.record.step_record_id, input.stepRecord);
    },
    endScenario(input: EndScenarioInput): void {
      writeAllureResults(writeOptions, [{ ...input, stepRecords }]);
      stepRecords = new Map();
    },
  };
}
