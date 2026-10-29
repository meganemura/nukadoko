import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ListKind } from "../execution-events/lists.js";
import type { Finding } from "../finding/finding.js";
import { runDir } from "./run-exports.js";
import { runRelativeDir, runsRelativeDir } from "./state-layout.js";
import type { AfterStepEndCounts, ScenarioEvidence, ScenarioHookRecord, ScenarioStatus, ScenarioStepStatus, ScenarioStop } from "./scenario-record.js";
import type { CountRange } from "../execution-events/count.js";
import type { PathKey, StepPath } from "../execution-events/path.js";
import type { TraceGap } from "../execution-events/tally.js";
import type { ClaimReadingValue, ClaimRecord, ErrorKind, EventsReadRecord, ObservedCounts } from "./types.js";

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
  /** The lines of the program's execution events that carry the step's
   * trace id and arrived after its record was written, found when the
   * world stopped. Present only when there is one. */
  readonly events_late?: RunEventsLate;
  /** What the program's execution events say the step did, counted by
   * what each line did, from every line of its trace: its slice and its
   * late lines alike, found when the world stopped. Absent when the
   * world has no events file, or the step read none. */
  readonly path?: StepPath;
  /** A claim step's claims, as its step record holds them, with each value
   * whose JSON is longer than `CLAIM_VALUE_MAX_BYTES` cut (`RunClaim`). */
  readonly claims?: readonly RunClaim[];
  /** A claim step's `observation`, copied from its step record. */
  readonly observation?: "observed" | "unobserved";
  /** A claim step's `attempts`, copied from its step record. */
  readonly attempts?: number;
  /** A claim step's readings of execution events, copied from its step
   * record. */
  readonly events_read?: Readonly<Record<string, EventsReadRecord>>;
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

/** A step's late lines of the program's execution events. */
export interface RunEventsLate {
  readonly lines: number;
  /** `events-late.jsonl` in the step record's directory, or `null` when
   * it could not be written. */
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
export type RunClaim = ClaimRecord & { readonly actual_bytes?: number; readonly expected_bytes?: number; readonly after_world_stop?: RunAfterWorldStop };

/** A claim on a count of execution events, judged again once the world
 * stopped, over every line of the producer's trace the program wrote:
 * present only when lines of that trace arrived after the claim was
 * judged. When `outcome` is not the claim's own, the claim was judged on
 * lines that were still on their way, and the run marks the cell
 * `broke`. */
export interface RunAfterWorldStop {
  /** The readable lines of the trace, all of them. */
  readonly lines: number;
  readonly range: CountRange;
  readonly outcome: "held" | "broken" | "unjudged";
  /** How many lines arrived after the claim, and, for `unjudged`, why
   * the count still answers nothing. */
  readonly reason: string;
}

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
  readonly status: ScenarioStatus;
  /** Present when a walk was stopped with steps still to run: the step it
   * was stopped after, and its line. `status` is then `stopped`, or
   * `failed` when an After hook failed after the stop. */
  readonly stopped?: ScenarioStop;
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
  /** For a failed or stopped scenario: the command that runs it alone, in
   * its own environment. Absent for a control execution, whose failure is what the
   * table reads as proof, not a failure to rerun. */
  readonly do?: string;
  /** How this execution counts in the table (`table.rows[].cells[].role`):
   * `required` where the environment meets every condition the scenario's
   * tags name, `control` where it does not. Absent in a run.json an
   * earlier build wrote. */
  readonly role?: "required" | "control";
  /** The world this execution ran in, for an execution of the base or the
   * old world of `nuka run --base`; absent for head's. */
  readonly world?: "base" | "old";
  /** For an execution of the base or the old world: the row of the table
   * it is a cell of. `feature` and `line` above, and each step's
   * `line`, are where it ran, in that world's own feature file, which for
   * the old world is the ref's. */
  readonly row?: { readonly feature: string; readonly line: number };
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

/** What one cell of the table holds after its executions: `pass` when
 * every one passed; `fail` when every one broke the same claim of a Then
 * at `line`; `broke` when every one stopped at `line` before a claim there
 * was judged (a Given or When error, an undefined line, a claim nukadoko
 * could not judge, a hook); `stopped` when a walk (`nuka run --step`) was
 * stopped after the step at `line`, so the steps after it did not run;
 * `flaky` when they disagree, `line` naming the first that did not pass;
 * `not-run` when none ran, with the reason. */
export type RunCellOutcome = "pass" | "fail" | "broke" | "stopped" | "flaky" | "not-run";

/** A world of the run (docs/spec.md "Verdicts"): `head`, the tree the run
 * was started in; `base`, the ref's code under head's criteria and
 * mapping; `old`, head's code under the ref's criteria and mapping. */
export type RunWorldName = "head" | "base" | "old";

/** One criterion in one world and environment (src/run/verdict-table.ts). */
export interface RunTableCell {
  readonly world: RunWorldName;
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
  /** For `fail`: the claim every run broke, by its position among its
   * step's claims, counted from 0. Runs agree when they broke the same
   * claim at the same line, whatever value each saw. */
  readonly claim?: number;
  /** For `fail`: the actual value the broken claim saw in each run, in
   * run order, as a polled reading names a value. */
  readonly actuals?: readonly ClaimReadingValue[];
  /** Why a `not-run` cell did not run; for a `broke` cell at the
   * scenario's line, the hook every run failed in; for a control `broke`
   * whose proof round could not finish, why it could not. */
  readonly reason?: string;
}

/** What the table says of one criterion: green `held`, `proven`, or
 * `removed`; red `failed`, `unproven`, or `moved`. */
export type RunRowVerdict = "held" | "proven" | "removed" | "failed" | "unproven" | "moved";

/** The verdicts that turn the gate red. */
export const RED_VERDICTS: ReadonlySet<RunRowVerdict> = new Set(["failed", "unproven", "moved"]);

/** How a criterion compares with `nuka run --base`'s ref. */
export type RunRowChange = "unchanged" | "changed" | "new" | "removed";

/** One criterion: one scenario, or one Examples row of an outline. */
export interface RunTableRow {
  readonly feature: string;
  readonly line: number;
  readonly name: string;
  /** How the criterion compares with `--base`'s ref, `null` without
   * one. */
  readonly change: RunRowChange | null;
  /** For an `unchanged` criterion the ref holds under another name or in
   * another file: where. Its row runs in the old world, as a retagged
   * one does. */
  readonly renamed_from?: { readonly feature: string; readonly name: string };
  /** For an `unchanged` criterion whose tags differ from the ref's: `true`.
   * Its row runs in the old world, as one under a changed mapping does. */
  readonly retagged?: true;
  /** The criterion's condition tags and `@held`, as written, each once. */
  readonly conditions: readonly string[];
  /** One cell per world and environment the criterion runs in, in the
   * order of `worlds`. A `removed` criterion has none. */
  readonly cells: readonly RunTableCell[];
  readonly verdict: RunRowVerdict;
  /** Why the row has its verdict, in one sentence. */
  readonly reason: string;
  /** For a `removed` criterion: its sentences at the ref, as a person
   * reads them, since head no longer holds them. */
  readonly lines?: readonly string[];
}

/** What changed in the mapping since `nuka run --base`'s ref. */
export interface RunMappingChanges {
  readonly files: readonly string[];
  readonly config: boolean;
  readonly conditions: readonly string[];
  readonly default_environments: boolean;
  /** Why the comparison could not see the mapping whole, each a reason
   * that makes `mapping_changed` true (src/run/world-obstacles.ts). */
  readonly unseen: readonly string[];
}

/** run.json's `table`: one row per criterion, one cell per world and
 * environment (docs/spec.md "Verdicts"). */
export interface RunTable {
  /** The ref `nuka run --base` compared against, and the commit it named
   * when the run started; `null` without `--base`. */
  readonly base: { readonly ref: string; readonly commit: string } | null;
  /** Whether the mapping (every file under the features directory but the
   * `.feature` files, and the config's mapping part) changed since the
   * base; `null` without one. */
  readonly mapping_changed: boolean | null;
  /** What changed in the mapping since the base, `null` without one:
   * each file under the features directory but a `.feature` file that was
   * added, removed, or edited, relative to the project root; whether the
   * config's mapping part changed; each environment whose `conditions`
   * changed; whether `defaultEnvironments` changed; and what the
   * comparison could not see. */
  readonly mapping_changes: RunMappingChanges | null;
  /** The table's columns, in order: each world and environment. */
  readonly worlds: readonly { readonly world: RunWorldName; readonly environment: string }[];
  readonly rows: readonly RunTableRow[];
  /** How many selected criteria the run left out because `--env` named
   * no environment that meets their conditions: each would have had no
   * required cell, so nothing it showed would count. 0 without `--env`,
   * where `nuka check` reports such a criterion as `condition-unmet`. */
  readonly left_out: number;
  /** `--proof-runs`: how many runs that broke the same claim a control
   * needs before it proves its row, so a reader of the table knows what
   * `proven` took. */
  readonly proof_runs: number;
}

/** run.json's `flags`: one row per flag and side that a `flag` line of a
 * head step names (docs/spec.md "Execution events"), the side as the line
 * names it, never as an environment's conditions declare it
 * (src/run/flag-rows.ts). Evidence for a reader's decision, not a
 * verdict. */
export interface RunFlagRow {
  readonly name: string;
  readonly side: string;
  /** Each criterion with a head execution whose steps evaluated the flag
   * on this side, in the table's row order. */
  readonly criteria: readonly RunFlagCriterion[];
  readonly counts: RunPlaceCounts;
  /** Present when a head world's flags list was read: each environment
   * whose list declares this side of the flag, in the run's order; empty
   * for a side the lines named and no list declares. A row whose
   * `criteria` is empty is a declared side no criterion evaluated. */
  readonly listed_in?: readonly string[];
  /** Present on the one side of a flag that any criterion's steps
   * evaluated, when they evaluated no other side of it. */
  readonly only_side_evaluated?: true;
}

/** A criterion of a row of run.json's `flags` or `routes`: the table
 * row's identity and verdict, and the head cells whose executions reached
 * the row's place (src/run/place-criteria.ts). */
export interface RunPlaceCriterion<Cell extends RunPlaceCell> {
  readonly feature: string;
  readonly line: number;
  readonly name: string;
  /** The table row's verdict, over all its cells, at every place. */
  readonly verdict: Exclude<RunRowVerdict, "removed">;
  /** In the table's column order. */
  readonly cells: readonly Cell[];
}

/** A head cell of a place's criterion, as the table holds it. */
export interface RunPlaceCell {
  readonly environment: string;
  readonly role: "required" | "control";
  readonly outcome: RunCellOutcome;
  /** The line `fail`, `broke`, `stopped`, and `flaky` name. */
  readonly line?: number;
}

export type RunFlagCriterion = RunPlaceCriterion<RunFlagCell>;

/** A head cell of a flag row's criterion, with the gates of its flag
 * lines on the row's side. */
export interface RunFlagCell extends RunPlaceCell {
  /** Each gate the cell's flag lines on this side name, once: the
   * format's gates in its order, then any other word, then `null` for a
   * line that named none. */
  readonly gates: readonly (string | null)[];
}

/** A place's criteria by the verdict of their table row, counted where
 * the criterion has a required cell at the place. A criterion whose cells
 * there are all controls is counted under `controls` alone: its row's
 * verdict rests on cells elsewhere, and a control that broke is never
 * proof (docs/spec.md "Verdicts"). The six counts sum to the criteria. */
export interface RunPlaceCounts {
  readonly held: number;
  readonly proven: number;
  readonly failed: number;
  readonly unproven: number;
  readonly moved: number;
  readonly controls: number;
}

/** run.json's `routes`: one entry per method and route that a routes
 * list of a head world names or a `request` line of a head step names
 * (docs/spec.md "Lists"), so a route no step requested stands beside the
 * ones that were (src/run/route-rows.ts). A request line says which route
 * the program matched, never that a step checked what it answered, so an
 * entry claims requests and nothing more. */
export interface RunRoute {
  /** As the list and the lines name it, uppercase. */
  readonly method: string;
  /** The route's template; `null` for requests the program matched to
   * no route. */
  readonly route: string | null;
  /** Each handler a list named for the route, once, in text order. */
  readonly handlers: readonly string[];
  /** Each environment whose routes list names the route, in the run's
   * order; empty for a route no list that was read names. */
  readonly listed_in: readonly string[];
  /** How many `request` lines of head steps name the method and route,
   * in every environment; 0 for a route no step requested. */
  readonly requests: number;
  /** Each status those lines name, once, ascending. */
  readonly statuses: readonly number[];
  /** Each criterion with a head execution whose steps sent such a
   * request, in the table's row order. */
  readonly criteria: readonly RunRouteCriterion[];
  readonly counts: RunPlaceCounts;
}

export type RunRouteCriterion = RunPlaceCriterion<RunRouteCell>;

/** A head cell of a route's criterion, with the requests its executions'
 * steps sent to the route. */
export interface RunRouteCell extends RunPlaceCell {
  readonly requests: number;
  /** Each status those requests got, once, ascending. */
  readonly statuses: readonly number[];
}

/** run.json's `paths`: one entry per pair of sides whose steps' paths
 * the run compared (src/run/path-view.ts), so a reader about to turn a
 * change on for everyone reads what the program did differently on one
 * side than on the other. Evidence, not a verdict. */
export interface RunPathComparison {
  /** What the two sides differ in: two environments of the run whose
   * declared `conditions` differ in `name` alone, `a` holding the
   * value where it is `false` or not declared (`null`). */
  readonly between: { readonly kind: "condition"; readonly name: string; readonly a: boolean | string | null; readonly b: boolean | string | null };
  readonly a: RunPathSide;
  readonly b: RunPathSide;
  /** Why no criterion of the pair was compared, such as a side whose
   * world wrote no execution events; `null` when they were. */
  readonly unread: string | null;
  /** The criteria by `result`, and those not compared. */
  readonly counts: { readonly changed: number; readonly open: number; readonly same_so_far: number; readonly same: number; readonly not_compared: number };
  /** Each criterion compared, in the table's row order. */
  readonly criteria: readonly RunPathCriterion[];
  /** Each criterion not compared, with why, in the table's row order. */
  readonly not_compared: readonly { readonly feature: string; readonly line: number; readonly reason: string }[];
}

/** One side of a comparison: a world and an environment. */
export interface RunPathSide {
  readonly world: RunWorldName;
  readonly environment: string;
}

/** A criterion whose two sides' executions were compared step by step. */
export interface RunPathCriterion {
  readonly feature: string;
  readonly line: number;
  readonly name: string;
  /** `changed` when a step has a decided difference or ran on one side
   * only, `open` when every difference is one a side's missing lines
   * could still close, `same_so_far` when each of those reads the same
   * on both sides under the same gap words, `same` otherwise. */
  readonly result: "changed" | "open" | "same_so_far" | "same";
  /** The execution each side is read from, its cell's first, with the
   * cell's outcome. */
  readonly a: RunPathExecution;
  readonly b: RunPathExecution;
  /** The steps with a difference, in the scenario's order; absent for a
   * `same` criterion. */
  readonly steps?: readonly RunPathStep[];
}

export interface RunPathExecution {
  readonly scenario_record_id: string;
  readonly outcome: RunCellOutcome;
  /** The line `fail`, `broke`, `stopped`, and `flaky` name. */
  readonly line?: number;
}

/** A step of a compared criterion, aligned by its line in head's feature
 * file. */
export type RunPathStep =
  | {
      readonly line: number | null;
      readonly text: string;
      readonly ran: "both";
      /** Entries whose two counts cannot be equal. */
      readonly changed: readonly RunPathDifference[];
      /** Entries whose counts differ or may, where a side's missing lines
       * could still make them equal. */
      readonly open: readonly RunPathDifference[];
      /** The gaps that leave each side's counts unbounded. */
      readonly gaps: { readonly a: readonly TraceGap[]; readonly b: readonly TraceGap[] };
    }
  /** The step ran on this side only, since the other side's execution
   * stopped before it. What it did is the step's own `path`. */
  | { readonly line: number | null; readonly text: string; readonly ran: "a" | "b" };

/** One entry of a step's path, with the range of its count on each side. */
export type RunPathDifference = PathKey & { readonly a: CountRange; readonly b: CountRange };

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
  readonly phase: "build" | "prepare" | "serve" | "lists";
  readonly argv: readonly string[];
}

/** One pass of the run against one program (docs/spec.md "Program"): one
 * per environment of each tree the run builds. */
export interface RunWorld {
  /** The environment the world ran, the `environment` of its scenarios. */
  readonly name: string;
  /** Which tree the program was built from (`RunWorldName`). */
  readonly tree: RunWorldName;
  /** `true` on a base world whose ref holds no program file, so it was
   * built and started from head's. */
  readonly program_from_head?: true;
  /** The base URL every page and request resolved against: the port
   * nukadoko gave `serve`, or the program file's `url`. `null` for a world
   * with neither. */
  readonly url: string | null;
  /** What the world ran: build commands appear in the first world that
   * needed them, since a tree builds once per run. */
  readonly commands: readonly RunWorldCommand[];
  /** Milliseconds per phase, for the phases that ran. */
  readonly timings: Readonly<Partial<Record<"build_ms" | "prepare_ms" | "serve_ms" | "setup_ms" | "lists_ms" | "stop_ms", number>>>;
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
  /** What the program wrote to the file `{events}` names (docs/spec.md
   * "Execution events"). `null` for a world at a `url`, which nukadoko
   * does not start. Absent for a world whose program file names no
   * `{events}`, one with no URL, one that did not start, and in a
   * run.json an earlier build wrote. */
  readonly events?: RunWorldEvents | null;
  /** Each list of the program file's `lists` the world read
   * (docs/spec.md "Lists"), by kind. Present only for a head world
   * nukadoko served with an events file, whose program file names
   * `lists`. */
  readonly lists?: Readonly<Partial<Record<ListKind, RunWorldList>>>;
}

/** One list a world read: how many entries it holds, or why it was not
 * read, and then nothing of it counts. */
export type RunWorldList = { readonly entries: number; readonly error: null } | { readonly entries: null; readonly error: string };

/** A served world's execution events, counted when the world stopped. */
export interface RunWorldEvents {
  /** The world's copy of the file, every line redacted, relative to the
   * run directory; `null` when the copy could not be written. */
  readonly file: string | null;
  /** Every line the program wrote. */
  readonly lines: number;
  /** The readable lines that carry a trace id of the world, whichever
   * step or hook it belongs to. */
  readonly owned: number;
  /** The owned lines that arrived after their step's record was written:
   * each step's `events-late.jsonl`. */
  readonly late: number;
  /** The readable lines whose trace is none of the world's. */
  readonly unowned: number;
  /** The lines that are not one readable line of the format. */
  readonly unreadable: number;
  /** Readable lines whose kind the format does not define and that do
   * not start with `x_`, by kind: a misspelled kind, or a later
   * version's. */
  readonly undefined_kinds: Readonly<Record<string, number>>;
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
   * required cells, and `not_run` the required cells that never ran;
   * `controls` counts the executions of control cells, whatever they
   * ended in, and `controls_not_run` the control cells that never ran.
   * A control is evidence, not a test that gates, so it is counted apart. */
  readonly counts: {
    readonly scenarios: number;
    readonly passed: number;
    readonly failed: number;
    /** Required executions a walk stopped before their last step
     * (`nuka run --step`); 0 outside a walk. Not in `failed`. Absent in a
     * run.json an earlier build wrote. */
    readonly stopped?: number;
    readonly not_run: number;
    readonly controls: number;
    readonly controls_not_run: number;
  };
  /** One entry per scenario execution, in the order they finished. */
  readonly scenarios: readonly RunScenario[];
  /** The verdict table: what each criterion's cells came to, and the
   * verdict the exit code follows. */
  readonly table: RunTable;
  /** Present only when a `flag` line of a head step names a flag: one row
   * per flag and side (`RunFlagRow`). */
  readonly flags?: readonly RunFlagRow[];
  /** Present only when a routes list of a head world was read: one entry
   * per method and route (`RunRoute`). */
  readonly routes?: readonly RunRoute[];
  /** Present only when the run compared the steps' paths of a pair of
   * sides (`RunPathComparison`). */
  readonly paths?: readonly RunPathComparison[];
  /** Present only for a run started with `nuka run --step`: each pause,
   * and how it was answered. Between steps the world and the browser were
   * open to anything, so a reader or a gate tells such a run apart by
   * this field. */
  readonly walk?: RunWalk;
};

/** One open page as a walk's pause saw it, after its step ended. */
export interface PageView {
  /** The `pageAs(name)` context the page belongs to; `null` for the
   * default context. */
  readonly as: string | null;
  /** The page's place among its context's pages, from 1. */
  readonly page: number;
  /** Redacted, as the title and the ARIA snapshot are. */
  readonly url: string;
  /** `null` when the page did not give it in time. */
  readonly title: string | null;
  /** A viewport screenshot and an ARIA snapshot, relative to the run
   * directory; `null` when that capture failed or ran out of time. */
  readonly screenshot: string | null;
  readonly aria: string | null;
}

/** One pause of a walk: the step it came after, and its answer. */
export interface RunWalkPause {
  /** The step the run paused after, counted from 1 in its scenario. */
  readonly pause: number;
  readonly line: number | null;
  readonly step_record_id: string;
  readonly paused_at: string;
  readonly answered_at: string;
  readonly answer: "next" | "stop";
  /** The open pages, looked at after the step's record was written. */
  readonly views: readonly PageView[];
  /** Requests the open pages sent while the run waited at this pause,
   * relative to the run directory; present when they sent any. They are
   * not in the step's own `http.jsonl`. */
  readonly http?: string;
}

/** run.json's `walk`. */
export interface RunWalk {
  readonly pauses: readonly RunWalkPause[];
}

/** run.json as a reader gets it: the envelope every `--json` shares, and
 * the run's own fields. */
export interface RunDocument extends RunFields {
  readonly schema_version: number;
  readonly nukadoko: string;
  readonly command: "run";
  readonly verdict: "passed" | "failed";
  readonly findings: readonly Finding[];
}

/** The counts of `scenarios` and `table`, of head's executions and
 * cells: the base and the old world are the table's to read. An entry
 * without a `role` counts as required. */
export function countScenarios(scenarios: readonly Pick<RunScenario, "status" | "role" | "world">[], table: Pick<RunTable, "rows">): RunFields["counts"] {
  const head = scenarios.filter((scenario) => scenario.world === undefined);
  const required = head.filter((scenario) => scenario.role !== "control");
  const passed = required.filter((scenario) => scenario.status === "passed").length;
  const stopped = required.filter((scenario) => scenario.status === "stopped").length;
  return {
    scenarios: required.length,
    passed,
    failed: required.length - passed - stopped,
    stopped,
    not_run: notRunCells(table, "required"),
    controls: head.length - required.length,
    controls_not_run: notRunCells(table, "control"),
  };
}

function notRunCells(table: Pick<RunTable, "rows">, role: RunTableCell["role"]): number {
  return table.rows.reduce((total, row) => total + row.cells.filter((cell) => cell.world === "head" && cell.role === role && cell.outcome === "not-run").length, 0);
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
