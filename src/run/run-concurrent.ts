import type { ChildProcess } from "node:child_process";
import type { CellRole } from "../condition/condition.js";
import { parseFindings, warningSink, type Finding } from "../finding/finding.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pickle } from "@cucumber/messages";
import type { WritableSink } from "../sink/writable-sink.js";
import type { NukadokoConfig } from "../config/schema.js";
import { runExportsManifestPath } from "../record/run-exports.js";
import type { ScenarioRecord } from "../record/scenario-record.js";
import type { SecretSet } from "../secrets/types.js";
import {
  failedScenarioOf,
  type FailedScenario,
  writeScenarioBoundary,
  writeScenarioStarted,
  writeProofRunBoundary,
  createRepeatTally,
  type RepeatTally,
} from "./progress-log.js";
import type { SelectedFeature, SelectedScenarios } from "./select-pickles.js";
import { spawnRunWorker } from "./spawn-run-worker.js";
import { createLineBuffer } from "../sink/line-buffer.js";
import { exitCodeForSignal, HANDLED_SIGNALS } from "./process-signal.js";
import { parseWorkerEnvelope, type WorkerEnvelope } from "./worker-protocol.js";
import { serializeWorldView, type WorldView } from "../program/world-view.js";

// Responsibility: `nuka run --concurrency <n>`'s own parent-side
// orchestration (n > 1 and more than one feature file: every
// disqualifying case is decided by src/cli/run.ts before this module is
// ever called, so this file only ever runs the shape docs/spec.md
// "Scenarios (the scripted path)" describes for `--concurrency` above 1).
//
// This module never executes a pickle itself. It splits `selected.features`
// into `@nukadoko:serial` and not (the `Feature:` line's own tags — never a pickle's
// own merged `tags`, which would make a Scenario-level `@nukadoko:serial` and a
// Feature-level one indistinguishable), hands the non-`@nukadoko:serial` files to
// `min(concurrency, file count)` worker processes round-robin in the fixed
// byte order `nuka run` already selected them in, waits for all of them,
// then runs every `@nukadoko:serial` file afterward, one worker at a time. Actually
// executing one file is src/run/run-worker-entry.ts's job, in a process
// spawned by src/run/spawn-run-worker.ts — see those two files' own headers
// for why a worker cannot simply be handed this file's own in-memory
// bindings/config/fixture graph.
//
// Every worker's own stdout is a stream of `WorkerEnvelope` lines
// (src/run/worker-protocol.ts): a `"scenario"` envelope is this run's own
// real signal (its `record` is handed to `onRecord` unchanged, so run.json
// cannot tell it apart from one `--concurrency 1` would have written), while a `"note"`
// envelope is everything a worker would otherwise have written straight to
// stderr. Both ride the worker's stdout, reassembled into whole lines by
// src/sink/line-buffer.ts before either is ever touched, so a NDJSON record
// can never end up spliced together from two workers' own overlapping
// writes — the exact corruption this whole module exists to rule out.
//
// A scenario's own boundary line (`writeScenarioBoundary`) gets its index
// here, not from any worker: the "N/total" a worker's own progress line
// would have used at `--concurrency 1` numbers a scenario by its position
// in file order, and file order is exactly what workers running in
// parallel no longer preserve. This module numbers by arrival instead —
// the order scenarios actually finished in — which is the one order every
// worker's own stdout together still guarantees no worker can see on its
// own.
//
// Each arriving record is matched against its `{ feature, line }` pair
// (`pickleByKey`, below) in the pickles this parent parsed while selecting
// which files to hand out. Those parses are what sources.json keeps, so a
// record with no match there is one `nuka report` cannot render.
//
// A worker that exits non-zero without ever reporting a record for one of
// its own assigned files is treated as that file never having run at all
// (docs/spec.md: a run must never quietly report fewer records than it
// promised as if nothing happened) — `failedFiles`, below, names every such
// file and fails the whole invocation, regardless of what any other
// worker's own files did.
//
// SIGINT, SIGTERM, and SIGHUP follow the `--concurrency 1` rule (src/run/
// process-signal.ts) with the fixtures living in the workers. The first
// signal is forwarded to every running worker, each tears its fixtures
// down and exits, no further worker starts, and the run ends with the
// summary of what was written and exit code 128 plus the signal number. A
// second signal is forwarded too, which makes each worker exit at once,
// and the parent exits at once. On Windows nothing is forwarded
// (src/run/spawn-run-worker.ts says why). A parent that dies closes each
// worker's IPC channel. A worker treats that as its first signal, or, when
// a forwarded signal came first, lets the teardown it started finish.
//
// The parent owns each pass's world (src/program/world.ts): it starts the
// program before the pass's first worker and stops it after the last one,
// and every worker reads the world from a file the parent wrote. A world
// that does not start fails the pass, whose scenarios then have no record;
// the caller has already reported why, so the count below does not report
// them a second time as an incomplete run.
//
// A control cell (docs/spec.md "Verdicts") is a record like any other on
// the wire, but its failure is the table's to read, so it never fails the
// pass, never counts as a failed scenario, and never joins the scenario
// count or the repeat tallies. After a pass's workers, a control that
// failed at a Then line runs again, in the same world, until it has broken
// the same claim at that line `--proof-runs` times or a run disagrees: one worker per
// round, which runs every due target one after another, so a
// `@nukadoko:serial` file still runs alone and a round never races
// another. The caller decides which cells are due, from the records
// `onRecord` hands it.
//
// A proof round's worker is a process of its own, so it runs BeforeAll and
// AfterAll again. What goes wrong in a round (one of those hooks fails,
// or the worker exits without a record of a cell it was given) is the
// round's cells' to carry, never the run's: each cell of the round is
// `broke` with the reason (`onProofProblem`), the rounds stop, and a
// `proof-run-incomplete` warning says what happened. The run is red
// only for what it is red for without the round. Outside the rounds, a
// worker's failed hook fails the run, as it does at `--concurrency 1`.

const SERIAL_TAG = "@nukadoko:serial";

function isSerialFeature(feature: SelectedFeature): boolean {
  return feature.gherkinDocument.feature?.tags.some((tag) => tag.name === SERIAL_TAG) ?? false;
}

function pickleKey(relativeFeaturePath: string, line: number): string {
  return `${relativeFeaturePath}:${line}`;
}

/** One environment the run executes under (src/cli/run.ts's `EnvironmentPass`),
 * reduced to what this module needs. */
export interface ConcurrentPass {
  /** `--env`'s value for this environment, or `null` when the run named
   * none. Forwarded to every worker unresolved: a worker resolves it
   * itself. */
  readonly envArg: string | null;
  readonly environment: string;
  readonly targetVersion: string | undefined;
  readonly secrets: SecretSet;
  /** Starts the pass's world: `null` when the tree has no program file,
   * `"failed"` when the program did not start (the caller has reported
   * why). `close` stops the program after the pass. `abort` fires on the
   * first signal, and stops a start that is still waiting at once. */
  readonly openWorld: (abort: AbortSignal) => Promise<{ readonly view: WorldView; close(): Promise<void> } | "failed" | null>;
}

/** The caller's view of the table's cells (src/run/verdict-table.ts),
 * kept from the records `onRecord` hears. */
export interface ConcurrentCells {
  readonly roleOf: (feature: string, line: number, environment: string) => CellRole;
  /** Whether a control runs once more for proof, from its executions so
   * far. */
  readonly needsProof: (feature: string, line: number, environment: string) => boolean;
  /** How many executions a cell holds so far. */
  readonly runsOf: (feature: string, line: number, environment: string) => number;
  /** `--proof-runs`. */
  readonly proofRuns: number;
  /** Hears that a proof round could not record a control's run, and why,
   * so its cell reads `broke` with the reason. */
  readonly onProofProblem: (feature: string, line: number, environment: string, reason: string) => void;
}

/** One proof round: the cells it was given, the ones it recorded a run
 * of, and what went wrong in its worker. */
interface ProofRound {
  readonly cells: readonly { readonly feature: string; readonly line: number }[];
  readonly recorded: Set<string>;
  readonly problems: string[];
}

export interface RunConcurrentOptions {
  readonly rootDir: string;
  readonly config: NukadokoConfig;
  readonly runId: string;
  /** Every environment of the run, in the order `--env` gave them. Each one
   * is a pass of its own over every selected file: its parallel phase and
   * then its serial files, before the next environment starts, so a
   * `@nukadoko:serial` file still runs alone and two environments never
   * share a target at once. */
  readonly passes: readonly ConcurrentPass[];
  readonly concurrency: number;
  /** `--repeat`; each worker runs its own files this many times
   * (src/cli/run.ts's `RunRunOptions.repeat`). */
  readonly repeat: number;
  readonly selected: SelectedScenarios;
  readonly flatPickles: readonly { readonly feature: SelectedFeature; readonly pickle: Pickle }[];
  readonly cells: ConcurrentCells;
  /** Hears every scenario record the parent forwards, so the parent builds
   * one run.json for the whole run, and streams it under `--records`. */
  readonly onRecord: (record: ScenarioRecord) => void;
  /** Scenario boundaries and a failed step's lines; src/cli/run.ts passes
   * a sink that drops them under `--json`. */
  readonly progress: WritableSink;
  /** Every warning and failure this function finds, as a finding; the
   * caller writes it to stderr or keeps it for the `--json` document. */
  readonly warn: (finding: Finding) => void;
  /** Hears that a worker's BeforeAll failed in `environment`, so the
   * table can say why its cells there did not run. */
  readonly onBeforeAllFailed: (environment: string) => void;
  /** The `do` of a BeforeAll or AfterAll failure in `environment`: a
   * worker does not know the targets the run was given. */
  readonly runHookDo: (environment: string) => string;
  /** A worker's own stderr, relayed raw: it is a crash or project code's
   * output, not nukadoko's, so it has no finding to be. */
  readonly stderr: WritableSink;
}

interface WorkerGroupResult {
  readonly exitCode: number;
  readonly filesWithRecords: ReadonlySet<string>;
}

export interface RunConcurrentResult {
  readonly allPassed: boolean;
  /** Executions of required cells; a control's are in run.json and the
   * table, not in the scenario count. */
  readonly scenariosWritten: number;
  readonly scenariosPassed: number;
  readonly stepRecordsWritten: number;
  readonly failedScenarios: readonly FailedScenario[];
  /** Empty unless `repeat` is above 1. */
  readonly repeatTallies: readonly RepeatTally[];
  /** The first SIGINT or SIGTERM this run received, or `null`. */
  readonly interruptedBy: NodeJS.Signals | null;
}

/**
 * Runs every selected pickle across worker processes and returns the same
 * tallies src/cli/run.ts's own `--concurrency 1` loop produces, so its
 * caller can print the same output-location/summary lines either way. Never
 * throws: a worker's own crash is reported through `failedFiles`, never an
 * exception out of this function.
 */
export async function runConcurrentPickles(options: RunConcurrentOptions): Promise<RunConcurrentResult> {
  const {
    rootDir,
    config,
    runId,
    passes,
    concurrency,
    repeat,
    selected,
    flatPickles,
    cells,
    onRecord,
    progress,
    warn,
    stderr,
  } = options;
  const warnings = (code: string): WritableSink => warningSink(code, warn);

  const hasPickles = flatPickles.length > 0;
  let expectedRecords = flatPickles.length * repeat * passes.length;
  // The total the numbered scenario lines count to: the selection, never
  // the proof runs, which have lines of their own.
  let mainRecords = expectedRecords;

  const pickleByKey = new Map<string, { readonly feature: SelectedFeature; readonly pickle: Pickle }>();
  for (const entry of flatPickles) {
    pickleByKey.set(pickleKey(entry.feature.relativePath, entry.pickle.location?.line ?? 0), entry);
  }

  let allPassed = true;
  // Every record, controls and proof runs included, for the completeness
  // check; `scenariosWritten` counts required executions only.
  let recordsWritten = 0;
  let scenariosWritten = 0;
  let scenariosPassed = 0;
  let stepRecordsWritten = 0;
  const failedScenarios: FailedScenario[] = [];
  const repeatTally = createRepeatTally();
  // The one counter a worker cannot compute for itself (this file's own
  // header) — shared across every worker and every phase, so a scenario's
  // own boundary line always reads as "the Nth one to finish, out of the
  // whole run's total", parallel phase and serial phase alike.
  let completedCount = 0;

  // A worker writes each note as one finding in its text grammar. A note
  // that does not parse is still reported, so nothing a worker says is lost.
  let currentEnvironment = "";
  // A failure a proof round's worker reports (a hook, a lost channel) is
  // the round's to carry, so it is kept for its cells rather than relayed
  // as a failure of the run. Outside the rounds, it fails the run.
  function relayNote(text: string, round: ProofRound | null): void {
    const parsed = parseFindings(text);
    if (parsed.length === 0) {
      warn({ severity: "warning", code: "worker-output-unreadable", message: text });
      return;
    }
    for (const finding of parsed) {
      if (finding.severity === "failed") {
        if (round !== null) {
          round.problems.push(finding.message);
          continue;
        }
        allPassed = false;
      }
      warn({
        severity: finding.severity,
        code: finding.code,
        message: finding.message,
        ...(finding.fix !== undefined ? { fix: finding.fix } : {}),
        ...(finding.do !== undefined
          ? { do: finding.do }
          : finding.code === "hook-failed"
            ? { do: options.runHookDo(currentEnvironment) }
            : {}),
      });
    }
  }

  function handleEnvelope(envelope: WorkerEnvelope, filesWithRecords: Set<string>, worker: number, round: ProofRound | null): void {
    if (envelope.kind === "note") {
      relayNote(envelope.text, round);
      return;
    }

    // A proof round's BeforeAll leaves its cells without a run, which the
    // round reports for them; the environment's other cells did run.
    if (envelope.kind === "before-all-failed") {
      if (round === null) options.onBeforeAllFailed(currentEnvironment);
      return;
    }

    if (envelope.kind === "scenario-started") {
      writeScenarioStarted(progress, {
        worker,
        relativeFeaturePath: envelope.feature,
        line: envelope.line,
        name: envelope.name,
      });
      return;
    }

    const { record, stepLines, notes } = envelope;
    filesWithRecords.add(record.feature);
    round?.recorded.add(pickleKey(record.feature, record.line));
    recordsWritten += 1;
    const control = cells.roleOf(record.feature, record.line, record.environment) === "control";

    if (!control) {
      scenariosWritten += 1;
      if (record.status === "passed") {
        scenariosPassed += 1;
      } else {
        allPassed = false;
        failedScenarios.push(failedScenarioOf(record));
      }
      if (repeat > 1) repeatTally.note(record);
    }
    stepRecordsWritten += record.steps.filter((step) => step.step_record_id !== null).length;
    onRecord(record);

    if (round !== null) {
      writeProofRunBoundary(progress, {
        relativeFeaturePath: record.feature,
        line: record.line,
        name: record.scenario,
        environment: record.environment,
        run: cells.runsOf(record.feature, record.line, record.environment),
        of: cells.proofRuns,
      });
    } else {
      completedCount += 1;
      writeScenarioBoundary(progress, {
        index: completedCount,
        total: mainRecords,
        relativeFeaturePath: record.feature,
        line: record.line,
        name: control ? `${record.scenario}  (control)` : record.scenario,
      });
    }
    for (const line of stepLines) {
      progress.write(`${line}\n`);
    }
    for (const note of notes) relayNote(note, round);

    const match = pickleByKey.get(pickleKey(record.feature, record.line));
    if (match === undefined) {
      // A worker parses its own assigned files, so its pickles normally
      // match the ones selected here exactly. They can diverge when a
      // feature file changes on disk between this parent's own selection
      // and the worker's own parse. The record itself is already in
      // run.json; without this line `nuka report` would leave it out with
      // nothing saying so.
      warn({
        severity: "warning",
        code: "record-unmatched",
        file: record.feature,
        line: record.line,
        message: "No selected scenario matches the record a worker reported here; nuka report cannot render it",
      });
    }
  }

  const liveWorkers = new Set<ChildProcess>();
  let interruptedBy: NodeJS.Signals | null = null;

  // `targets` are what a worker's list file holds: a feature path, or a
  // path and line. A `round` runs each target once, as a proof run.
  async function runWorkerGroup(
    targets: readonly string[],
    worker: number,
    envArg: string | null,
    world: WorldView | null,
    round: ProofRound | null,
  ): Promise<WorkerGroupResult> {
    const filesWithRecords = new Set<string>();
    if (interruptedBy !== null) {
      return { exitCode: exitCodeForSignal(interruptedBy), filesWithRecords };
    }
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nukadoko-run-"));
    const featureListPath = path.join(tmpDir, "features.txt");
    try {
      await writeFile(featureListPath, `${targets.join("\n")}\n`, "utf8");
      const worldPath = world === null ? null : path.join(tmpDir, "world.json");
      if (worldPath !== null && world !== null) await writeFile(worldPath, serializeWorldView(world), "utf8");
      // A signal can arrive during the two awaits above.
      if (interruptedBy !== null) {
        return { exitCode: exitCodeForSignal(interruptedBy), filesWithRecords };
      }
      const child = spawnRunWorker({ rootDir, runId, env: envArg, featureListPath, repeat: round !== null ? 1 : repeat, worldPath });
      liveWorkers.add(child);

      const stdoutBuffer = createLineBuffer((line) => {
        if (line.length === 0) {
          return;
        }
        const envelope = parseWorkerEnvelope(line);
        if (envelope === undefined) {
          warn({ severity: "warning", code: "worker-output-unreadable", message: `A worker produced an unreadable line on its own stdout: ${line}` });
          return;
        }
        handleEnvelope(envelope, filesWithRecords, worker, round);
      });
      // Relayed raw, never parsed: this worker's own real stderr carries a
      // pre-try/catch Node crash and project code's own stdout writes
      // (src/run/worker-protocol.ts's header).
      const stderrBuffer = createLineBuffer((line) => {
        if (line.length > 0) {
          stderr.write(`${line}\n`);
        }
      });

      child.stdout.on("data", (chunk: Buffer) => stdoutBuffer.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrBuffer.push(chunk));

      // `"close"`, never `"exit"`: Node fires `"exit"` the moment the process
      // ends, but data already queued in libuv for `child.stdout`/`.stderr`
      // can still be delivered after that event — resolving on `"exit"`
      // risks reading `filesWithRecords` (and finishing this function) one
      // tick before a record that was already in flight actually arrives.
      // `"close"` is documented to fire only once every stdio stream has
      // ended too, which is the actual "nothing more is coming" signal this
      // function needs. `"error"` (e.g. `ENOENT` on the interpreter itself)
      // can fire with no `"close"` ever following, so it still needs its own
      // path to the same `finish`.
      const exitCode = await new Promise<number>((resolve) => {
        let settled = false;
        const finish = (code: number): void => {
          if (!settled) {
            settled = true;
            resolve(code);
          }
        };
        child.once("close", (code) => finish(code ?? 1));
        child.once("error", () => finish(1));
      });
      liveWorkers.delete(child);
      stdoutBuffer.flush();
      stderrBuffer.flush();

      return { exitCode, filesWithRecords };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  const targetsOf = (files: readonly SelectedFeature[]): string[] =>
    files.flatMap((feature) =>
      feature.selectedLines === null ? [feature.relativePath] : feature.selectedLines.map((line) => `${feature.relativePath}:${line}`),
    );
  const parallelFeatures = selected.features.filter((feature) => !isSerialFeature(feature));
  const serialFeatures = selected.features.filter(isSerialFeature);

  const failedFiles = new Set<string>();

  // The parent starts each world, and a signal while one is starting
  // stops it at once instead of waiting for it to answer.
  const startAbort = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => {
    if (process.platform !== "win32") {
      for (const child of liveWorkers) child.kill(signal);
    }
    if (interruptedBy !== null) process.exit(exitCodeForSignal(signal));
    interruptedBy = signal;
    startAbort.abort();
  };
  for (const signal of HANDLED_SIGNALS) process.on(signal, onSignal);
  try {
    for (const pass of passes) {
      // A signal stops the run before the next environment starts.
      if (interruptedBy !== null) break;
      if (passes.length > 1) progress.write(`environment ${pass.environment}\n`);
      currentEnvironment = pass.environment;
      const world = hasPickles ? await pass.openWorld(startAbort.signal) : null;
      if (world === "failed") {
        // A start the signal stopped leaves this environment's scenarios
        // without records, which is what makes the run incomplete.
        if (interruptedBy !== null) break;
        expectedRecords -= flatPickles.length * repeat;
        mainRecords -= flatPickles.length * repeat;
        allPassed = false;
        continue;
      }
      try {
        await runPass(pass.envArg, world?.view ?? null);
        await runProofRounds(pass, world?.view ?? null);
      } finally {
        await world?.close();
      }
    }
  } finally {
    for (const signal of HANDLED_SIGNALS) process.off(signal, onSignal);
  }

  async function runPass(envArg: string | null, world: WorldView | null): Promise<void> {
    const workerCount = Math.min(concurrency, parallelFeatures.length);
    if (workerCount > 0) {
      const buckets: SelectedFeature[][] = Array.from({ length: workerCount }, () => []);
      parallelFeatures.forEach((feature, index) => {
        buckets[index % workerCount]!.push(feature);
      });

      const results = await Promise.all(buckets.map((bucket, bucketIndex) => runWorkerGroup(targetsOf(bucket), bucketIndex + 1, envArg, world, null)));
      for (const [bucketIndex, result] of results.entries()) {
        if (result.exitCode !== 0) {
          for (const feature of buckets[bucketIndex]!) {
            if (!result.filesWithRecords.has(feature.relativePath)) {
              failedFiles.add(envArg === null ? feature.relativePath : `${feature.relativePath} (${envArg})`);
            }
          }
        }
      }
    }

    // One worker at a time, strictly after every parallel worker has already
    // exited (the `await` above already guarantees that) — a `@nukadoko:serial` file's
    // whole reason to exist is that nothing else may be running while it is.
    for (const feature of serialFeatures) {
      // Worker 1: a `@nukadoko:serial` file runs alone, so there is never a
      // second number to tell it apart from.
      const result = await runWorkerGroup(targetsOf([feature]), 1, envArg, world, null);
      if (result.exitCode !== 0 && !result.filesWithRecords.has(feature.relativePath)) {
        failedFiles.add(envArg === null ? feature.relativePath : `${feature.relativePath} (${envArg})`);
      }
    }
  }

  // One round at a time, so a cell stops at the first run that disagrees.
  // A round that went wrong (a hook of its worker failed, or the worker
  // left a cell without a record) ends the rounds: each of its cells is
  // `broke` with the reason, and its missing records are not counted as
  // missing from the run, since the cells account for them. A signal that
  // stopped the round leaves the count to report them.
  async function runProofRounds(pass: ConcurrentPass, world: WorldView | null): Promise<void> {
    for (;;) {
      if (interruptedBy !== null) return;
      const due = flatPickles.filter(({ feature, pickle }) => cells.needsProof(feature.relativePath, pickle.location?.line ?? 0, pass.environment));
      if (due.length === 0) return;
      expectedRecords += due.length;
      const round: ProofRound = {
        cells: due.map(({ feature, pickle }) => ({ feature: feature.relativePath, line: pickle.location?.line ?? 0 })),
        recorded: new Set(),
        problems: [],
      };
      const result = await runWorkerGroup(
        round.cells.map((cell) => pickleKey(cell.feature, cell.line)),
        1,
        pass.envArg,
        world,
        round,
      );
      if (interruptedBy !== null) return;
      const missing = round.cells.filter((cell) => !round.recorded.has(pickleKey(cell.feature, cell.line)));
      const reason =
        round.problems.length > 0
          ? `the worker of its proof run failed: ${round.problems.join("; ")}`
          : missing.length > 0
            ? `the worker of its proof run exited with code ${result.exitCode} and recorded no run of it`
            : undefined;
      if (reason === undefined) continue;
      expectedRecords -= missing.length;
      for (const cell of round.cells) cells.onProofProblem(cell.feature, cell.line, pass.environment, reason);
      const named = round.cells.map((cell) => pickleKey(cell.feature, cell.line)).join(", ");
      warn({
        severity: "warning",
        code: "proof-run-incomplete",
        message:
          `A proof round in environment "${pass.environment}" did not finish: ${reason}. ` +
          `The control ${round.cells.length === 1 ? "cell" : "cells"} it was given (${named}) ${round.cells.length === 1 ? "reads" : "read"} broke, and the run's verdict does not change`,
      });
      return;
    }
  }

  if (interruptedBy !== null) {
    warn({
      severity: "failed",
      code: "run-incomplete",
      message:
        recordsWritten === expectedRecords
          ? `${interruptedBy} arrived after every scenario had a record, so AfterAll hooks may not have run`
          : `${interruptedBy} stopped this run before every scenario had a record, so it is incomplete`,
    });
    allPassed = false;
  } else if (failedFiles.size > 0) {
    warn({
      severity: "failed",
      code: "run-incomplete",
      message:
        `A worker exited without writing any record for: ${[...failedFiles].sort().join(", ")}. ` +
        "This run is incomplete and cannot be treated as a pass",
    });
    allPassed = false;
  } else if (recordsWritten !== expectedRecords) {
    // The total check `failedFiles` cannot make. That set catches a worker
    // that produced nothing at all for a file it was given, which is the
    // loud case. A record lost some other way (an unreadable envelope line,
    // a worker that exited zero having skipped a pickle) leaves this run
    // reporting fewer records than it selected pickles, with every other
    // signal green. Counting closes that gap for every cause at once,
    // including causes nobody has thought of yet.
    warn({
      severity: "failed",
      code: "run-incomplete",
      message:
        `This run selected ${flatPickles.length} scenarios${repeat > 1 ? ` to run ${repeat} times each` : ""}` +
        `${passes.length > 1 ? ` in each of ${passes.length} environments` : ""}` +
        `${expectedRecords > mainRecords ? `, with ${expectedRecords - mainRecords} proof run${expectedRecords - mainRecords === 1 ? "" : "s"},` : ""}` +
        ` and wrote ${recordsWritten} records. ` +
        "The missing ones cannot be accounted for, so this run is incomplete",
    });
    allPassed = false;
  }

  return {
    allPassed,
    scenariosWritten,
    scenariosPassed,
    stepRecordsWritten,
    repeatTallies: repeatTally.list(),
    failedScenarios,
    interruptedBy,
  };
}
