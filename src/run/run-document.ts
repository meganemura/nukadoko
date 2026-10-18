import type { GherkinDocument, Pickle, Step as GherkinStep } from "@cucumber/messages";
import type { RunScenario, RunStep, RunUsed } from "../record/run-result.js";
import type { ScenarioRecord } from "../record/scenario-record.js";
import type { StepRecord } from "../record/types.js";

// Responsibility: one scenario's entry in run.json, built from the scenario
// as it ran and the step records it wrote. Pure: the caller reads the step
// records and knows the paths, the step names, and the rerun command.
//
// Each step carries what a reader needs to act on it without opening its
// step record: the line, the step it matched, the record path, and, for a
// failure, the message, the error kind, and the results it read. The
// declaration and the measurement (`mutates`, `observed`) ride along so the
// run summary's "Declared vs observed" section is rendered from run.json
// alone. Args and the step's own result stay in the step record: they can be
// large, and nothing on the next decision needs them.

export interface RunScenarioInput {
  /** The step records the scenario cites, by id; `null` for one that could
   * not be read. */
  readonly stepRecords: ReadonlyMap<string, StepRecord | null>;
  /** The line of the scenario's step at this index, or `null`. */
  readonly stepLine: (index: number) => number | null;
  /** The one step name a line's text matches, or `null`. */
  readonly stepName: (text: string) => string | null;
  /** A step record's path, as run.json names it: relative to the run
   * directory. */
  readonly recordPath: (stepRecordId: string) => string;
  /** The scenario's evidence directory, as run.json names it: relative to
   * the run directory. */
  readonly evidenceDir: string;
  /** The command that reruns this scenario, used when it failed. */
  readonly rerun: string;
}

/** Whether the scenario wrote a file into its own evidence directory: the
 * final screenshot, a hook's trace chunk, or a hook's attachment. A
 * scenario that wrote none leaves an empty directory, which `nuka run`
 * removes once the run is over, and its run.json entry names no evidence. */
export function wroteScenarioEvidence(record: ScenarioRecord): boolean {
  return (
    record.evidence.screenshots.length > 0 ||
    record.hooks.some(
      (hook) =>
        hook.trace !== undefined ||
        (hook.named_traces?.length ?? 0) > 0 ||
        (hook.declared?.attachments?.length ?? 0) > 0,
    )
  );
}

function usedOf(stepRecord: StepRecord, recordPath: (id: string) => string): RunUsed[] | undefined {
  if (stepRecord.status !== "failed" || stepRecord.used === undefined || stepRecord.used.length === 0) return undefined;
  return stepRecord.used.map((entry) => ({ step: entry.step, record: recordPath(entry.step_record_id), result: entry.result }));
}

export function buildRunScenario(record: ScenarioRecord, input: RunScenarioInput): RunScenario {
  const steps = record.steps.map((entry, index): RunStep => {
    const stepRecord = entry.step_record_id === null ? null : (input.stepRecords.get(entry.step_record_id) ?? null);
    const used = stepRecord === null ? undefined : usedOf(stepRecord, input.recordPath);
    const kind = stepRecord?.status === "failed" ? stepRecord.error.kind : null;
    return {
      line: input.stepLine(index),
      text: entry.text,
      step: input.stepName(entry.text),
      status: entry.status,
      step_record_id: entry.step_record_id,
      record: entry.step_record_id === null ? null : input.recordPath(entry.step_record_id),
      ...(stepRecord === null ? {} : { mutates: stepRecord.mutates, observed: stepRecord.observed }),
      ...(entry.error === undefined ? {} : { error: { kind, message: entry.error.message } }),
      ...(used === undefined ? {} : { used }),
    };
  });
  return {
    scenario_record_id: record.scenario_record_id,
    feature: record.feature,
    line: record.line,
    scenario: record.scenario,
    status: record.status,
    started_at: record.started_at,
    finished_at: record.finished_at,
    ...(record.browser === undefined ? {} : { browser: record.browser }),
    steps,
    hooks: record.hooks,
    ...(wroteScenarioEvidence(record) ? { evidence: { ...record.evidence, dir: input.evidenceDir } } : {}),
    ...(record.teardown_errors === undefined ? {} : { teardown_errors: record.teardown_errors }),
    ...(record.status === "failed" ? { do: input.rerun } : {}),
    ...(record.probes === undefined
      ? {}
      : {
          probes: record.probes.map(({ step_index, ...probe }) => ({ line: input.stepLine(step_index), ...probe })),
        }),
  };
}

/** Every step's line in the document, by the gherkin step id a pickle step
 * names first. */
export function gherkinStepLines(document: GherkinDocument): Map<string, number> {
  const lines = new Map<string, number>();
  const add = (steps: readonly GherkinStep[] | undefined): void => {
    for (const step of steps ?? []) lines.set(step.id, step.location.line);
  };
  for (const child of document.feature?.children ?? []) {
    add(child.background?.steps);
    add(child.scenario?.steps);
    for (const ruleChild of child.rule?.children ?? []) {
      add(ruleChild.background?.steps);
      add(ruleChild.scenario?.steps);
    }
  }
  return lines;
}

/** The line of each of a pickle's steps, or `null` where the document has
 * none for it. */
export function pickleStepLines(pickle: Pickle, lines: ReadonlyMap<string, number>): (index: number) => number | null {
  return (index) => {
    const id = pickle.steps[index]?.astNodeIds[0];
    return id === undefined ? null : (lines.get(id) ?? null);
  };
}
