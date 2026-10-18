import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Finding } from "../finding/finding.js";
import { runDir } from "./run-exports.js";
import { runRelativeDir, runsRelativeDir } from "./state-layout.js";
import type { ProbeNotMeasuredReason, ProbeStatus, ProbeValue, ScenarioEvidence, ScenarioHookRecord, ScenarioStepStatus } from "./scenario-record.js";
import type { ErrorKind, ObservedCounts } from "./types.js";

// Responsibility: run.json, the one document a `nuka run` leaves in its
// own directory, `<stateDir>/runs/<run_id>/`, and what `nuka run --json`
// prints. It holds what
// an agent or an auditor needs without opening another file: the commit and
// condition the run ran under, every scenario with its steps, each failed
// step's message and the values it read, the command that reruns a failed
// scenario, and every finding the run raised. The run summary is rendered
// from this document alone (src/run/run-summary.ts), so the two cannot
// disagree, and a summary can be rendered again from a run.json copied off
// a CI machine. Step records sit beside it, under the same directory's
// `steps/`, for the detail: traces, screenshots, `http.jsonl`, and the full
// args and result of each step. Every path the document names is relative
// to the run directory, so a run directory reads the same after it is
// uploaded, downloaded, or moved.
//
// It is also the run's completion marker. Only the invocation that ran
// everything knows the run is over and how it ended (a run-scope hook can
// fail after every scenario passed), so it writes this file last, and
// retention and `nuka tend` read its presence as proof that the run ended.
// A rename makes the write atomic, so retention in another process never
// reads half a file as "no marker".

export const RUN_RESULT_FILE_NAME = "run.json";

export interface RunUsed {
  readonly step: string;
  /** The producer's step record directory, relative to the run directory. */
  readonly record: string;
  /** The producer's result, or a bounded preview of it when `truncated`
   * (src/run/run-document.ts's `boundUsedResult`); `record` holds the
   * whole value. */
  readonly result: unknown;
  readonly truncated?: true;
  /** The whole result's JSON size in bytes, only when `truncated`. */
  readonly result_bytes?: number;
}

export interface RunStep {
  /** The step's line in its feature file; `null` when the pickle step names
   * no line in the document. */
  readonly line: number | null;
  readonly text: string;
  /** The step name the line matched, or `null` when it matched none or
   * more than one. */
  readonly step: string | null;
  readonly status: ScenarioStepStatus;
  /** The step record's id, the value `nuka do --use` takes; `null` when
   * none was written (the step never began). */
  readonly step_record_id: string | null;
  /** The step record's directory, relative to the run directory
   * (`steps/<step_record_id>`); `null` when none was written. */
  readonly record: string | null;
  /** The step's `mutates` declaration, present when it has a step record. */
  readonly mutates?: boolean | null;
  /** What the step record measured, present when it has one. */
  readonly observed?: ObservedCounts;
  /** `true` when the step wrote a step record that could not be read back,
   * so `mutates` and `observed` are missing for a reason, not because
   * nothing ran. */
  readonly record_unreadable?: true;
  /** Present when the step failed, or never began for a reason
   * (`undefined`, `ambiguous`). `kind` is the step record's `error.kind`,
   * and `null` when no step record says. */
  readonly error?: { readonly kind: ErrorKind | null; readonly message: string };
  /** For a failed step that read results from earlier steps: each one, and
   * the result it read. */
  readonly used?: readonly RunUsed[];
}

export interface RunScenario {
  readonly scenario_record_id: string;
  readonly feature: string;
  readonly line: number;
  readonly scenario: string;
  /** The environment this execution ran under, one of the run's
   * `environments`. */
  readonly environment: string;
  readonly status: "passed" | "failed";
  readonly started_at: string;
  readonly finished_at: string;
  /** The browser this scenario launched, when it launched one. */
  readonly browser?: { readonly type: string; readonly version: string };
  readonly steps: readonly RunStep[];
  readonly hooks: readonly ScenarioHookRecord[];
  /** The scenario's own evidence directory (hook traces and attachments,
   * the final screenshot), relative to the run directory
   * (`scenarios/<scenario_record_id>`). Absent when the scenario left none
   * of them, since the directory is then removed. */
  readonly evidence?: ScenarioEvidence;
  readonly teardown_errors?: readonly { readonly fixture: string; readonly message: string }[];
  /** For a failed scenario: the command that runs it alone, in its own
   * environment. */
  readonly do?: string;
  /** Under `--probe`: each Then re-run with one capture changed. Not a
   * step: it has no step record. */
  readonly probes?: readonly RunProbe[];
  /** What moved in this scenario's criteria since `nuka run --since`'s
   * ref. Absent in a run.json an earlier build wrote. */
  readonly criteria?: RunCriteria;
}

/** How a scenario's own lines (Background, steps, docstrings, tables, its
 * Examples row) compare with the same scenario at the `--since` ref. */
export type CriteriaChange = "unchanged" | "changed" | "new";

export interface RunCriteria {
  /** `null` for a run without `--since`. */
  readonly changed_since: CriteriaChange | null;
  /** The scenario's lines in the working tree, for a `changed` or `new`
   * one: what a reader approves. */
  readonly lines?: readonly string[];
  /** Under `--since`: the step files the scenario's lines bound to,
   * relative to the project root. `since.step_files` says which changed. */
  readonly step_files?: readonly string[];
}

/** The ref `nuka run --since` compared against. */
export interface RunSince {
  /** The ref as given. */
  readonly ref: string;
  /** The commit it named when the run started. */
  readonly commit: string;
  /** Every step file a scenario of the run bound to, relative to the
   * project root, and whether its text differs from the commit's. */
  readonly step_files: readonly { readonly file: string; readonly changed: boolean }[];
}

export interface RunProbe {
  /** The Then's line in its feature file, or `null`. */
  readonly line: number | null;
  readonly step: string;
  readonly text: string;
  readonly key: string;
  readonly recorded: ProbeValue;
  readonly changed: ProbeValue;
  /** `passed` is the `then-passed-with-changed-capture` note, and
   * `not-measured` the `then-probe-not-measured` note. */
  readonly status: ProbeStatus;
  readonly reason?: ProbeNotMeasuredReason;
  readonly message?: string;
}

/** One scenario under one environment: `failed` when any of its
 * executions failed (src/run/verdicts.ts). */
export interface RunVerdict {
  readonly feature: string;
  readonly line: number;
  readonly scenario: string;
  readonly environment: string;
  /** `not-run` for a selected scenario that never ran in that
   * environment, such as after its BeforeAll failed. */
  readonly verdict: "passed" | "failed" | "not-run";
  /** More than 1 under `--repeat`; 0 for `not-run`. */
  readonly executions: number;
  readonly passed: number;
}

/** A condition the run ran under: an environment from the config. */
export interface RunEnvironment {
  readonly name: string;
  /** What the environment's version probe answered, `null` without one. */
  readonly target_version: string | null;
}

/** The fields `nuka run` puts beside the envelope's `findings`. */
export type RunFields = {
  readonly run_id: string;
  readonly started_at: string;
  readonly finished_at: string;
  /** The commit and whether the working tree had uncommitted changes when
   * the run started; `null` outside git or before the first commit. */
  readonly commit: { readonly sha: string; readonly dirty: boolean } | null;
  /** Every environment the run ran under, in the order `--env` named
   * them; `default` alone without `--env`. Each selected scenario ran once
   * per environment. */
  readonly environments: readonly RunEnvironment[];
  /** `partial` when a `:line` target left out some scenarios of its file,
   * so the run covers less than the files it names. */
  readonly selection: "full" | "partial";
  /** `scenarios`, `passed`, and `failed` count executions; `not_run`
   * counts the `verdicts` cells that never ran. */
  readonly counts: { readonly scenarios: number; readonly passed: number; readonly failed: number; readonly not_run: number };
  /** One entry per scenario execution, in the order they finished. */
  readonly scenarios: readonly RunScenario[];
  /** One entry per (scenario, environment), red when any execution of it
   * was red. */
  readonly verdicts: readonly RunVerdict[];
  /** `nuka run --since`'s ref, or `null` without it. Absent in a run.json
   * an earlier build wrote. */
  readonly since?: RunSince | null;
};

/** run.json as a reader gets it: the envelope every `--json` shares, and
 * the run's own fields. */
export interface RunDocument extends RunFields {
  readonly schema_version: number;
  readonly nukadoko: string;
  readonly command: "run";
  readonly verdict: "passed" | "failed";
  readonly findings: readonly Finding[];
}

export function countScenarios(scenarios: readonly Pick<RunScenario, "status">[], verdicts: readonly Pick<RunVerdict, "verdict">[] = []): RunFields["counts"] {
  const passed = scenarios.filter((scenario) => scenario.status === "passed").length;
  return { scenarios: scenarios.length, passed, failed: scenarios.length - passed, not_run: verdicts.filter((cell) => cell.verdict === "not-run").length };
}

export function runResultPath(rootDir: string, stateDir: string, runId: string): string {
  return path.join(runDir(rootDir, stateDir, runId), RUN_RESULT_FILE_NAME);
}

/** The run.json path relative to the project root, as stderr names it. */
export function runResultRelativePath(stateDir: string, runId: string): string {
  return path.join(runRelativeDir(stateDir, runId), RUN_RESULT_FILE_NAME);
}

/** Writes the document text as it is, so the file and `--json` stdout are
 * the same bytes. */
export function writeRunResult(rootDir: string, stateDir: string, runId: string, text: string): void {
  const filePath = runResultPath(rootDir, stateDir, runId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  try {
    renameSync(temporary, filePath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The document at `filePath` when it reads as a run.json: an object for
 * `nuka run` with a verdict, a parsable `started_at`, and a `scenarios`
 * list. `null` for anything else, so a damaged file never dates a run. */
export function readRunResult(filePath: string): RunDocument | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const document = parsed as Record<string, unknown>;
    if (document.command !== "run") return null;
    if (document.verdict !== "passed" && document.verdict !== "failed") return null;
    if (typeof document.run_id !== "string" || typeof document.started_at !== "string") return null;
    if (Number.isNaN(Date.parse(document.started_at)) || !Array.isArray(document.scenarios)) return null;
    return parsed as RunDocument;
  } catch {
    return null;
  }
}

/** Every run that ended, read from its run.json, in no particular order. */
export function readEndedRuns(rootDir: string, stateDir: string): RunDocument[] {
  const runsDir = path.join(rootDir, runsRelativeDir(stateDir));
  let ids: string[];
  try {
    ids = readdirSync(runsDir).sort();
  } catch {
    return [];
  }
  return ids.flatMap((id) => {
    const document = readRunResult(path.join(runsDir, id, RUN_RESULT_FILE_NAME));
    return document === null || document.run_id !== id ? [] : [document];
  });
}
