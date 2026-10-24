import type { GherkinDocument, Pickle, Step as GherkinStep } from "@cucumber/messages";
import type { RunScenario, RunStep, RunUsed } from "../record/run-result.js";
import type { ScenarioRecord } from "../record/scenario-record.js";
import type { ObservedCounts, StepRecord } from "../record/types.js";

// Responsibility: one scenario's entry in run.json, built from the scenario
// as it ran and the step records it wrote. Pure: the caller reads the step
// records and knows the paths, the step names, and the rerun command.
//
// Each step carries what a reader needs to act on it without opening its
// step record: the line, the step it matched, the record path, and, for a
// failure, the message, the error kind, and the results it read. The
// declaration and the measurement (`mutates`, `observed`) ride along so the
// run summary can name a failed step's process, and a step's unmeasured
// actions, from run.json alone. A changed file's content stays in the step
// record, as a process's output does: run.json carries the path, the
// change, and the size. Args and the step's own result stay in the step record: they can be
// large, and nothing on the next decision needs them. A failed step's
// `used` results are the exception, because the failure often is what an
// upstream step returned (a process that exited nonzero, and its stderr).
// They are bounded (`boundUsedResult`): a 5 MB producer result would
// otherwise make a 5 MB run.json and `--json` document, and the producer's
// `record` still holds the whole value.

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

/** The most a used result's JSON takes in run.json, in UTF-8 bytes. */
export const USED_RESULT_MAX_BYTES = 4096;
/** The most of one string field a bounded preview keeps, in characters:
 * enough for the first lines of a process's stderr. */
export const USED_PREVIEW_STRING_CHARS = 1024;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/** A used result as run.json carries it: the value itself when its JSON
 * fits `USED_RESULT_MAX_BYTES`, or else a preview with `truncated` and the
 * whole value's size. The preview keeps an object's top-level numbers,
 * booleans, and nulls, and the start of each top-level string, in key
 * order, each one that still fits, so `exitCode` and the first line of `stderr`
 * survive; any other value previews as `null`. Pure. */
export function boundUsedResult(result: unknown): { readonly result: unknown; readonly truncated?: true; readonly result_bytes?: number } {
  const bytes = jsonBytes(result);
  if (bytes <= USED_RESULT_MAX_BYTES) return { result };
  let preview: unknown = null;
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result)) {
      const shown =
        typeof value === "string"
          ? value.slice(0, USED_PREVIEW_STRING_CHARS)
          : typeof value === "number" || typeof value === "boolean" || value === null
            ? value
            : undefined;
      if (shown === undefined) continue;
      kept[key] = shown;
      if (jsonBytes(kept) > USED_RESULT_MAX_BYTES) {
        delete kept[key];
      }
    }
    preview = kept;
  }
  return { result: preview, truncated: true, result_bytes: bytes };
}

function usedOf(stepRecord: StepRecord, recordPath: (id: string) => string): RunUsed[] | undefined {
  if (stepRecord.status !== "failed" || stepRecord.used === undefined || stepRecord.used.length === 0) return undefined;
  return stepRecord.used.map((entry) => ({ step: entry.step, record: recordPath(entry.step_record_id), ...boundUsedResult(entry.result) }));
}

/** `observed` without the content of each changed file. */
function observedForRun(observed: ObservedCounts): ObservedCounts {
  if (!Array.isArray(observed.files)) return observed;
  return { ...observed, files: observed.files.map(({ content: _content, ...rest }) => rest) };
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
      ...(stepRecord === null
        ? entry.step_record_id === null
          ? {}
          : { record_unreadable: true as const }
        : { mutates: stepRecord.mutates, observed: observedForRun(stepRecord.observed) }),
      ...(entry.error === undefined ? {} : { error: { kind, message: entry.error.message } }),
      ...(used === undefined ? {} : { used }),
      ...(entry.after_step_end === undefined ? {} : { after_step_end: entry.after_step_end }),
    };
  });
  return {
    scenario_record_id: record.scenario_record_id,
    feature: record.feature,
    line: record.line,
    scenario: record.scenario,
    environment: record.environment,
    status: record.status,
    started_at: record.started_at,
    finished_at: record.finished_at,
    ...(record.browser === undefined ? {} : { browser: record.browser }),
    steps,
    hooks: record.hooks,
    ...(wroteScenarioEvidence(record) ? { evidence: { ...record.evidence, dir: input.evidenceDir } } : {}),
    ...(record.teardown_errors === undefined ? {} : { teardown_errors: record.teardown_errors }),
    ...(record.status === "failed" ? { do: input.rerun } : {}),
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
