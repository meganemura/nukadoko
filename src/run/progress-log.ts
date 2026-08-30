import type { WritableSink } from "../cli/writable-sink.js";

// Responsibility: `nuka run`'s own progress output — what src/context.ts
// and src/compat/allure-runtime.ts used to call "a future progress-log
// feature" before this file existed. Every function
// here writes to stderr only; stdout's one-JSON-record-per-scenario contract
// (src/cli/run.ts) is untouched by any of it. Display only: nothing written
// here is read back by `nuka accept` or any other command, so its exact
// wording is free to change without a compat concern. `--quiet` is not this
// file's own concern — cli/run.ts decides which of these calls to make, this
// file just formats and writes.

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
}

function formatStepDuration(durationMs: number): string {
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
export function createStepProgressLogger(stderr: WritableSink): (info: StepProgressInfo) => void {
  return (info: StepProgressInfo): void => {
    stderr.write(
      `  step ${info.stepIndex}/${info.totalSteps}  ${formatStepStatusWord(info.status)}  ` +
        `${formatStepDuration(info.durationMs)}  ${info.text}\n`,
    );
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

function formatSummaryDuration(durationMs: number): string {
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

/** Names only the scenario records counted as failures by the summary.
 * The caller retains these three display values instead of retaining every
 * record from the run. */
export function writeFailedScenarios(stderr: WritableSink, failures: readonly FailedScenario[]): void {
  for (const failure of failures) {
    stderr.write(`failed  ${failure.feature}:${failure.line}  ${failure.scenario}\n`);
  }
}
