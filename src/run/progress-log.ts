import path from "node:path";
import type { WritableSink } from "../sink/writable-sink.js";

// Responsibility: `nuka run`'s own progress output — what src/step/context.ts
// and src/compat/allure-runtime.ts used to call "a future progress-log
// feature" before this file existed. Every function
// here writes to stderr only; stdout's one-JSON-record-per-scenario contract
// (src/cli/run.ts) is untouched by any of it. Display only: nothing written
// here is read back by any command, so its exact
// wording is free to change without a compat concern. `--quiet` is mostly not this
// file's concern: cli/run.ts decides which of these calls to make. The one
// exception is the step logger, which alone knows whether a step failed,
// and a failed step's lines survive the flag.

/** One pickle step's own outcome, reported once it stops running.
 * `stepIndex` is 1-based ("step 3/20", how a person reads a position, not a
 * 0-based array index) — src/run/run-scenario.ts's `pushStepRecord` is the
 * one place that computes it, from that scenario's own `stepRecords.length`
 * right after appending, so it can never drift from the step actually being
 * reported. */
export interface StepProgressInfo {
  readonly stepIndex: number;
  readonly totalSteps: number;
  readonly status: "passed" | "failed" | "skipped";
  readonly durationMs: number;
  readonly text: string;
  /** The scenario record's `error.message` for this step, secrets already
   * redacted, present whenever `status` is `"failed"`. */
  readonly errorMessage?: string;
  /** `null` for a step that never began, so it has no step record. */
  readonly stepRecordId: string | null;
}

export interface StepProgressOptions {
  /** Root-relative, as the config holds it: the record line names the step
   * record by the path a reader can open from the project root. */
  readonly stateDir: string;
  /** Under `--quiet` only a failed step writes, and it writes the same lines
   * it would without the flag. The flag asks for a quieter terminal, and a
   * CI log that says FAIL but not why is the reason this output exists. */
  readonly quiet: boolean;
}

// Playwright's assertion messages carry color codes; a CI log or a file
// shows them as literal escape noise.
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** The first line of an error message that has any text in it, without
 * color codes and trailing space: enough to say why a step failed in one
 * line, while the step record keeps the whole message. A message with no
 * visible text reads `(no message)` so the line is never blank. */
export function firstErrorLine(message: string): string {
  for (const line of message.replace(ANSI_ESCAPE, "").split(/\r\n?|[\n\u2028\u2029]/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "(no message)";
}

export interface StepFailure {
  readonly errorMessage: string | undefined;
  /** Root-relative path of the step record, or `null` when none was written. */
  readonly recordPath: string | null;
}

/** The lines that say why one step failed, unindented: the error's first
 * line, then where its step record is. Kept apart from the stderr writer so
 * a run summary in another format can say the same thing the same way. */
export function formatStepFailure(failure: StepFailure): string[] {
  const lines = [firstErrorLine(failure.errorMessage ?? "")];
  if (failure.recordPath !== null) lines.push(`record  ${failure.recordPath}`);
  return lines;
}

/** `<stateDir>/records/steps/<id>`, the directory every step record is
 * written to (src/record/read-step-record.ts). */
export function stepRecordPath(stateDir: string, stepRecordId: string): string {
  return path.join(stateDir, "records", "steps", stepRecordId);
}

/** Seconds with one decimal, the unit a step or a scenario reads in. */
export function formatStepDuration(durationMs: number): string {
  return `${(Math.max(0, durationMs) / 1000).toFixed(1)}s`;
}

/** `"ok"` / `"FAIL"` / `"skip"` — three words, not `ScenarioStepStatus`'s
 * five verbatim (passed/failed/skipped must be told apart at a glance).
 * `undefined`/`ambiguous` both fold into `"FAIL"` here: both are "never
 * began, and this scenario is now failing" outcomes as far as a progress
 * line reader needs to know; their own detail still lands on the scenario
 * record unabridged. */
function formatStepStatusWord(status: StepProgressInfo["status"]): string {
  switch (status) {
    case "passed":
      return "ok";
    case "skipped":
      return "skip";
    case "failed":
      return "FAIL";
  }
}

/** Builds this run's own step-progress callback — one instance per `nuka
 * run` invocation, built once by cli/run.ts and threaded unchanged into
 * every `runScenario` call, the same "build once, pass a callback" shape
 * `createTraceVersionWarner` (src/context/trace-actions.ts) already
 * established. Unlike that warner, this one never stops firing: a progress
 * line's whole point is to keep appearing for as long as the scenario runs.
 * One line, never wrapped (a long step name runs off the right edge rather
 * than break the one-step-one-line guarantee). */
export function createStepProgressLogger(
  stderr: WritableSink,
  options: StepProgressOptions,
): (info: StepProgressInfo) => void {
  return (info: StepProgressInfo): void => {
    if (options.quiet && info.status !== "failed") return;
    let text =
      `  step ${info.stepIndex}/${info.totalSteps}  ${formatStepStatusWord(info.status)}  ` +
      `${formatStepDuration(info.durationMs)}  ${info.text}\n`;
    if (info.status === "failed") {
      const failure = formatStepFailure({
        errorMessage: info.errorMessage,
        recordPath: info.stepRecordId === null ? null : stepRecordPath(options.stateDir, info.stepRecordId),
      });
      text += failure.map((line) => `      ${line}\n`).join("");
    }
    stderr.write(text);
  };
}

export interface ScenarioBoundary {
  readonly index: number;
  readonly total: number;
  readonly relativeFeaturePath: string;
  readonly line: number;
  readonly name: string;
}

/** One line per pickle, written by cli/run.ts right before that pickle's
 * own execution begins — unindented, unlike a step line, so a reader
 * scanning stderr can tell a scenario boundary apart from a step line at a
 * glance, without reading either line's own words. */
export function writeScenarioBoundary(stderr: WritableSink, boundary: ScenarioBoundary): void {
  stderr.write(
    `scenario ${boundary.index}/${boundary.total}  ${boundary.relativeFeaturePath}:${boundary.line}  ` +
      `${boundary.name}\n`,
  );
}

export interface ScenarioStart {
  /** 1-based, the parent's own bucket number for the worker that is
   * running this scenario. */
  readonly worker: number;
  readonly relativeFeaturePath: string;
  readonly line: number;
  readonly name: string;
}

/** One line when a scenario *begins*, written only by a `--concurrency <n>`
 * run's parent (src/run/run-concurrent.ts). A serial run's own boundary
 * line above is already written at that moment, so it needs no second one;
 * a parallel run's is not, because the parent only hears from a worker when
 * a scenario ends, which leaves the last line of a hung run naming the
 * scenario before the one that hung.
 *
 * No index, deliberately: `writeScenarioBoundary`'s own number means "the
 * Nth to finish", and reusing it here would give one number two meanings in
 * one log. The worker number is what this line adds instead, so a reader
 * can tell which of several in-flight scenarios a later line belongs to. */
export function writeScenarioStarted(stderr: WritableSink, start: ScenarioStart): void {
  stderr.write(
    `scenario start  worker ${start.worker}  ${start.relativeFeaturePath}:${start.line}  ${start.name}\n`,
  );
}

/** One row of "where this run wrote" — `count` is omitted for a stream
 * this run either wrote in full or not at all (`allure`, `messages`),
 * never a count of anything. `kind` only decides the trailing slash: a
 * directory reads as one, a file (`messages.ndjson`) does not. Callers
 * pass only the rows this run actually has — this function has no "was
 * this really written" judgment of its own to make; see cli/run.ts's own
 * call site for which condition gates which row. */
export interface OutputLocation {
  readonly label: string;
  readonly relativePath: string;
  readonly kind: "dir" | "file";
  readonly count?: number;
}

const LABEL_WIDTH = 10;
const PATH_WIDTH = 30;

function formatOutputLocation(location: OutputLocation): string {
  const displayPath = location.kind === "dir" ? `${location.relativePath}/` : location.relativePath;
  const label = location.label.padEnd(LABEL_WIDTH);
  if (location.count === undefined) {
    return `${label}${displayPath}\n`;
  }
  return `${label}${displayPath.padEnd(PATH_WIDTH)}${location.count}\n`;
}

export function writeOutputLocations(stderr: WritableSink, locations: readonly OutputLocation[]): void {
  for (const location of locations) {
    stderr.write(formatOutputLocation(location));
  }
}

export interface RunSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly durationMs: number;
}

export interface FailedScenario {
  readonly feature: string;
  readonly line: number;
  readonly scenario: string;
}

/** `1h 2m 3s`, the unit a whole run reads in. */
export function formatSummaryDuration(durationMs: number): string {
  const totalSeconds = Math.round(Math.max(0, durationMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (hours > 0 || minutes > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

/** The one line `nuka run` used to leave to the exit code alone —
 * always written, `--quiet` included: this and `writeOutputLocations`
 * above are each written exactly once per invocation, and "where did
 * output land" is never worth suppressing for a flag whose whole point is
 * a quieter terminal, not a silent one. */
export function writeRunSummary(stderr: WritableSink, summary: RunSummary): void {
  stderr.write(
    `${summary.total} scenario${summary.total === 1 ? "" : "s"}: ${summary.passed} passed, ` +
      `${summary.failed} failed  (${formatSummaryDuration(summary.durationMs)})\n`,
  );
}

export interface RepeatTally {
  readonly feature: string;
  readonly line: number;
  readonly scenario: string;
  readonly passed: number;
  readonly total: number;
}

export interface RepeatTallyCollector {
  note(record: { readonly feature: string; readonly line: number; readonly scenario: string; readonly status: string }): void;
  /** Every scenario seen, in first-seen order. */
  list(): RepeatTally[];
}

/** Counts, per scenario, how many of its executions passed: the one
 * fact a `--repeat` run exists to produce, kept as three display values
 * plus two counters per scenario rather than as every record. Keyed by
 * feature and line, the same identity a `:line` target names. */
export function createRepeatTally(): RepeatTallyCollector {
  const tallies = new Map<string, { feature: string; line: number; scenario: string; passed: number; total: number }>();
  return {
    note(record): void {
      const key = `${record.feature}\u0000${record.line}`;
      const entry = tallies.get(key) ?? { feature: record.feature, line: record.line, scenario: record.scenario, passed: 0, total: 0 };
      entry.total += 1;
      if (record.status === "passed") entry.passed += 1;
      tallies.set(key, entry);
    },
    list(): RepeatTally[] {
      return [...tallies.values()];
    },
  };
}

/** After the failed list, one line per scenario that failed at least once
 * under `--repeat`: `repeat  <feature>:<line>  <name>  <passed> of <total>
 * passed`. A scenario that passed every time is already covered by the
 * summary, and a run without `--repeat` has nothing to say here, so both
 * stay silent. Neither "flaky" nor any other verdict is written: a
 * scenario failing every time is not flaky, and the count is what a
 * reader needs to decide. */
export function writeRepeatTallies(stderr: WritableSink, tallies: readonly RepeatTally[]): void {
  for (const tally of tallies) {
    if (tally.passed === tally.total) continue;
    stderr.write(`repeat  ${tally.feature}:${tally.line}  ${tally.scenario}  ${tally.passed} of ${tally.total} passed\n`);
  }
}

/** Names only the scenario records counted as failures by the summary.
 * The caller retains these three display values instead of retaining every
 * record from the run. */
export function writeFailedScenarios(
  stderr: WritableSink,
  failures: readonly FailedScenario[],
  rerunFlags: readonly string[],
): void {
  for (const failure of failures) {
    stderr.write(`failed  ${failure.feature}:${failure.line}  ${failure.scenario}\n`);
    stderr.write(`  rerun  ${formatRerunCommand(failure, rerunFlags)}\n`);
  }
}

// Characters a POSIX shell reads as one plain word; anything else is single
// quoted, so a feature path with a space still pastes as one argument.
const SHELL_SAFE = /^[A-Za-z0-9_./:=+,-]+$/;

function shellWord(word: string): string {
  return SHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** The command that runs one failed scenario again, in the same environment.
 * `rerunFlags` carries only flags that change which world the scenario ran
 * against (`--env`): a flag that only shapes output stays out, so the line
 * stays short enough to copy. */
export function formatRerunCommand(failure: Pick<FailedScenario, "feature" | "line">, rerunFlags: readonly string[]): string {
  return ["nuka", "run", `${failure.feature}:${failure.line}`, ...rerunFlags].map(shellWord).join(" ");
}
