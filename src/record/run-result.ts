import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Finding } from "../finding/finding.js";
import { runDir } from "./run-exports.js";
import { runRelativeDir, runsRelativeDir } from "./state-layout.js";
import type { AfterStepEndCounts, ScenarioEvidence, ScenarioHookRecord, ScenarioStepStatus } from "./scenario-record.js";
import type { ClaimRecord, ErrorKind, ObservedCounts } from "./types.js";

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
// retention and `nuka report` read its presence as proof that the run ended.
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
  /** The step record's scenario entry's `after_step_end`: actions the step
   * started after its record was written. */
  readonly after_step_end?: AfterStepEndCounts;
  /** The lines of the program's log that carry the step's trace id and
   * arrived after its record was written, found when the world stopped.
   * Present only when there is one. */
  readonly program_log_late?: RunProgramLogLate;
  /** A claim step's claims, as its step record holds them, with each value
   * whose JSON is longer than `CLAIM_VALUE_MAX_BYTES` cut (`RunClaim`). */
  readonly claims?: readonly RunClaim[];
  /** A claim step's `observation`, copied from its step record. */
  readonly observation?: "observed" | "unobserved";
  /** A claim step's `attempts`, copied from its step record. */
  readonly attempts?: number;
}

/** A step's late lines of the program's log. */
export interface RunProgramLogLate {
  readonly lines: number;
  /** `program-log-late.txt` in the step record's directory, or `null`
   * when it could not be written. */
  readonly file: string | null;
  /** The lines came to more than 16 MiB, so the file holds the first of
   * them. */
  readonly truncated?: true;
}

/** A claim as run.json carries it. A value whose JSON is longer than
 * `CLAIM_VALUE_MAX_BYTES` becomes the start of that JSON text, and
 * `actual_bytes` or `expected_bytes` holds the whole value's size; the
 * step record keeps the value whole. An item claim of `each` is cut the
 * same way. */
export type RunClaim = ClaimRecord & { readonly actual_bytes?: number; readonly expected_bytes?: number };

/** The longest claim value, as JSON, that run.json carries whole. */
export const CLAIM_VALUE_MAX_BYTES = 1024;

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
   * environment. Absent for a control execution, whose failure is what the
   * table reads as proof, not a failure to rerun. */
  readonly do?: string;
  /** How this execution counts in the table (`table.rows[].cells[].role`):
   * `required` where the environment meets every condition the scenario's
   * tags name, `control` where it does not. Absent in a run.json an
   * earlier build wrote. */
  readonly role?: "required" | "control";
  /** What moved in this scenario's criteria since `nuka run --since`'s
   * ref. Absent in a run.json an earlier build wrote. */
  readonly criteria?: RunCriteria;
  /** How the claims of the scenario's claim steps came out, counted once
   * per claim (an `each` is one claim). `unobserved` and `unjudged` are
   * present only above 0. A claim step that did not run counts nothing.
   * Absent in a run.json an earlier build wrote. */
  readonly claims?: RunScenarioClaims;
  /** Present only for a scenario in which no claim on a Then line was
   * judged (held, broken, or unjudged; a claim on another line does not
   * count): `compat` when a compat step is bound in Then position, so a
   * judgment nukadoko cannot see may have been made by a throw, and
   * `nothing` otherwise. */
  readonly judged_by?: "compat" | "nothing";
}

/** A scenario's claim counts by outcome. */
export interface RunScenarioClaims {
  readonly held: number;
  readonly broken: number;
  readonly unobserved?: number;
  readonly unjudged?: number;
}

/** How a scenario's own criteria (its tags, steps with their effective
 * keyword, docstrings and tables, and its Examples row) compare with the
 * same scenario at the `--since` ref: `ambiguous` when scenarios of one
 * name differ in content and cannot be paired, `unknown` when the ref's
 * file does not parse. src/run/criteria-since.ts says what counts. */
export type CriteriaChange = "unchanged" | "changed" | "new" | "ambiguous" | "unknown";

export interface RunCriteria {
  /** `null` for a run without `--since`. */
  readonly changed_since: CriteriaChange | null;
  /** Why an `ambiguous` or `unknown` scenario could not be decided. */
  readonly reason?: string;
  /** The scenario's criteria in the working tree, as a person reads them,
   * for any scenario that is not `unchanged`: what a reader approves. */
  readonly lines?: readonly string[];
  /** Under `--since`: the files that register the steps the scenario's
   * lines bound to, the files of the parts those steps declare, and the
   * config file when a step needs a fixture it defines, relative to the
   * project root. `since.step_files` says which changed. */
  readonly step_files?: readonly string[];
}

/** How a step file compares with the `--since` commit, as git compares
 * them: `untracked` when the commit does not hold it. */
export type StepFileChange = "unchanged" | "changed" | "untracked";

/** A criterion the ref held that nothing in the run matches. */
export interface RemovedCriterion {
  readonly feature: string;
  readonly rule: string | null;
  readonly scenario: string;
  /** The criterion at the ref, as a person reads it. */
  readonly lines: readonly string[];
}

/** The ref `nuka run --since` compared against. */
export interface RunSince {
  /** The ref as given. */
  readonly ref: string;
  /** The commit it named when the run started. */
  readonly commit: string;
  /** The run's targets, relative to the project root, without a `:line`:
   * what was compared. A feature file outside them is not. */
  readonly compared: readonly string[];
  /** Criteria the ref held in the compared files that are gone. */
  readonly removed: readonly RemovedCriterion[];
  /** Every file a scenario's `step_files` names, and how it compares with
   * the commit. */
  readonly step_files: readonly { readonly file: string; readonly change: StepFileChange }[];
}

/** What one cell of the table holds after its executions: `pass` when
 * every one passed; `fail` when every one broke a claim of a Then at
 * `line`; `broke` when every one stopped at `line` before a claim there
 * was judged (a Given or When error, an undefined line, a claim nukadoko
 * could not judge, a hook); `flaky` when they disagree, `line` naming
 * the first that did not pass; `not-run` when none ran, with the reason. */
export type RunCellOutcome = "pass" | "fail" | "broke" | "flaky" | "not-run";

/** One criterion in one world and environment (src/run/verdict-table.ts). */
export interface RunTableCell {
  /** The world the cell ran in: `head`, the tree the run was started in. */
  readonly world: "head";
  readonly environment: string;
  readonly role: "required" | "control";
  /** What the role came from: for each condition the row's tags name, the
   * value the environment declares, or `null` when it declares none,
   * which counts as off. The environment's word, not a measurement:
   * nukadoko does not check it against the program (docs/spec.md
   * "Verdicts"). */
  readonly conditions: Readonly<Record<string, boolean | string | null>>;
  readonly outcome: RunCellOutcome;
  /** The feature file line `fail`, `broke`, and `flaky` name. */
  readonly line?: number;
  /** The executions the cell holds: more than 1 under `--repeat`, and for
   * a control whose Then failed, the proof runs (`--proof-runs`). */
  readonly runs: number;
  /** Why a `not-run` cell did not run. */
  readonly reason?: string;
}

/** What the table says of one criterion: green `held` or `proven`, red
 * `failed`. */
export type RunRowVerdict = "held" | "proven" | "failed";

/** One criterion: one scenario, or one Examples row of an outline. */
export interface RunTableRow {
  readonly feature: string;
  readonly line: number;
  readonly name: string;
  /** How the criterion compares with a base ref: `null`, since this
   * release compares none. */
  readonly change: null;
  /** The criterion's condition tags and `@held`, as written, each once. */
  readonly conditions: readonly string[];
  /** One cell per environment, in the run's order. */
  readonly cells: readonly RunTableCell[];
  readonly verdict: RunRowVerdict;
  /** Why the row has its verdict, in one sentence. */
  readonly reason: string;
}

/** run.json's `table`: one row per criterion, one cell per world and
 * environment (docs/spec.md "Verdicts"). */
export interface RunTable {
  /** The ref the run compared against: `null`, since this release
   * compares none. */
  readonly base: null;
  /** Whether the mapping changed since the base: `null` without one. */
  readonly mapping_changed: null;
  /** The table's columns, in order: each world and environment. */
  readonly worlds: readonly { readonly world: "head"; readonly environment: string }[];
  readonly rows: readonly RunTableRow[];
  /** How many selected criteria the run left out because `--env` named
   * no environment that meets their conditions: each would have had no
   * required cell, so nothing it showed would count. 0 without `--env`,
   * where `nuka check` reports such a criterion as `condition-unmet`. */
  readonly left_out: number;
}

/** A condition the run ran under: an environment from nukadoko.program.ts, or `default`. */
export interface RunEnvironment {
  readonly name: string;
  /** What the environment's version probe answered, `null` without one. */
  readonly target_version: string | null;
  /** The URL of the environment's world (`worlds[].url`), `null` without
   * one, so the run names the instance it judged and not only the commit.
   * Absent in a run.json an earlier build wrote. */
  readonly base_url?: string | null;
  /** What the environment declares under `conditions` in
   * nukadoko.program.ts; present only when it declares them. */
  readonly conditions?: Readonly<Record<string, boolean | string>>;
}

/** One command a world ran, in the order it ran. */
export interface RunWorldCommand {
  readonly phase: "build" | "prepare" | "serve";
  readonly argv: readonly string[];
}

/** One pass of the run against one program (docs/spec.md "Program"): in
 * this release, one per environment, of the tree the run was started in. */
export interface RunWorld {
  /** The environment the world ran, the `environment` of its scenarios. */
  readonly name: string;
  /** Which tree the program was built from: `head`, the tree the run was
   * started in. */
  readonly tree: "head";
  /** The base URL every page and request resolved against: the port
   * nukadoko gave `serve`, or the program file's `url`. `null` for a world
   * with neither. */
  readonly url: string | null;
  /** What the world ran: build commands appear in the first world that
   * needed them, since a tree builds once per run. */
  readonly commands: readonly RunWorldCommand[];
  /** Milliseconds per phase, for the phases that ran. */
  readonly timings: Readonly<Partial<Record<"build_ms" | "prepare_ms" | "serve_ms" | "setup_ms" | "stop_ms", number>>>;
  /** `program.log`, relative to the run directory, or `null` when the
   * world ran no command. */
  readonly log: string | null;
  /** Why the program did not start, or `null` when it did. */
  readonly error: string | null;
  /** What the program's log held of the steps' requests (docs/spec.md
   * "Trace context and the program's log"). `null` for a world at a
   * `url`, whose log nukadoko does not read. Absent for a world with no
   * URL, one that did not start, and in a run.json an earlier build
   * wrote. */
  readonly program_log?: RunWorldProgramLog | null;
}

/** A served world's program log, counted when the world stopped. */
export interface RunWorldProgramLog {
  /** The requests the steps sent to the world with a `traceparent`. */
  readonly stamped: number;
  /** The lines that went into a step's slice. */
  readonly lines: number;
  /** The lines that carry a step's trace id and arrived after its record
   * was written: each step's `program-log-late.txt`. */
  readonly late: number;
  /** Every line that carries a trace id of the world, whichever step or
   * hook it belongs to. 0 when the program does not tag its lines. */
  readonly tagged: number;
}

/** The fields `nuka run` puts beside the envelope's `findings`. */
export type RunFields = {
  readonly run_id: string;
  /** The run directory, relative to the project root with `/`
   * separators, so a script passes it to `nuka report` without knowing
   * the state directory's layout. Absent in a run.json an earlier build
   * wrote. */
  readonly run_dir?: string;
  readonly started_at: string;
  readonly finished_at: string;
  /** The commit and whether the working tree had uncommitted changes when
   * the run started; `null` outside git or before the first commit. */
  readonly commit: { readonly sha: string; readonly dirty: boolean } | null;
  /** Every environment the run ran under, in the order `--env` named
   * them, or without `--env`, the ones that declare conditions in the
   * program file's order, or `default` alone when none does. Each
   * selected scenario ran once per environment. */
  readonly environments: readonly RunEnvironment[];
  /** One per world the run started, in the order it started them; empty
   * when the tree has no program file. Absent in a run.json an earlier
   * build wrote. */
  readonly worlds?: readonly RunWorld[];
  /** `partial` when a `:line` target left out some scenarios of its file,
   * so the run covers less than the files it names. */
  readonly selection: "full" | "partial";
  /** `skipped` for a run started with `--no-check`, so no static finding
   * held it back; `ran` otherwise. Absent in a run.json an earlier build
   * wrote. */
  readonly check?: "ran" | "skipped";
  /** `scenarios`, `passed`, and `failed` count the executions of
   * required cells; `controls` counts the executions of control cells,
   * whatever they ended in; `not_run` counts the table's cells that never
   * ran. */
  readonly counts: {
    readonly scenarios: number;
    readonly passed: number;
    readonly failed: number;
    readonly controls: number;
    readonly not_run: number;
  };
  /** One entry per scenario execution, in the order they finished. */
  readonly scenarios: readonly RunScenario[];
  /** The verdict table: what each criterion's cells came to, and the
   * verdict the exit code follows. */
  readonly table: RunTable;
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

/** The counts of `scenarios` and `table`. An entry without a `role`
 * counts as required. */
export function countScenarios(scenarios: readonly Pick<RunScenario, "status" | "role">[], table: Pick<RunTable, "rows">): RunFields["counts"] {
  const required = scenarios.filter((scenario) => scenario.role !== "control");
  const passed = required.filter((scenario) => scenario.status === "passed").length;
  return {
    scenarios: required.length,
    passed,
    failed: required.length - passed,
    controls: scenarios.length - required.length,
    not_run: table.rows.reduce((total, row) => total + row.cells.filter((cell) => cell.outcome === "not-run").length, 0),
  };
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
