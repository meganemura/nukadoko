import type { ChildProcess } from "node:child_process";
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
  createRepeatTally,
  type RepeatTally,
} from "./progress-log.js";
import type { SelectedFeature, SelectedScenarios } from "./select-pickles.js";
import { spawnRunWorker } from "./spawn-run-worker.js";
import { createLineBuffer } from "../sink/line-buffer.js";
import { exitCodeForSignal, HANDLED_SIGNALS } from "./process-signal.js";
import { parseWorkerEnvelope, type WorkerEnvelope } from "./worker-protocol.js";

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

const SERIAL_TAG = "@nukadoko:serial";

function isSerialFeature(feature: SelectedFeature): boolean {
  return feature.gherkinDocument.feature?.tags.some((tag) => tag.name === SERIAL_TAG) ?? false;
}

function pickleKey(relativeFeaturePath: string, line: number): string {
  return `${relativeFeaturePath}:${line}`;
}

/** One environment the run executes under (src/cli/run.ts's `Condition`),
 * reduced to what this module needs. */
export interface ConcurrentCondition {
  /** `--env`'s value for this environment, or `null` when the run named
   * none. Forwarded to every worker unresolved: a worker resolves it
   * itself. */
  readonly envArg: string | null;
  readonly environment: string;
  readonly targetVersion: string | undefined;
  readonly secrets: SecretSet;
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
  readonly conditions: readonly ConcurrentCondition[];
  readonly concurrency: number;
  /** `--repeat`; each worker runs its own files this many times
   * (src/cli/run.ts's `RunRunOptions.repeat`). */
  readonly repeat: number;
  readonly selected: SelectedScenarios;
  readonly flatPickles: readonly { readonly feature: SelectedFeature; readonly pickle: Pickle }[];
  /** Hears every scenario record the parent forwards, so the parent builds
   * one run.json for the whole run, and streams it under `--records`. */
  readonly onRecord: (record: ScenarioRecord) => void;
  /** Scenario boundaries and a failed step's lines; src/cli/run.ts passes
   * a sink that drops them under `--json`. */
  readonly progress: WritableSink;
  /** Every warning and failure this function finds, as a finding; the
   * caller writes it to stderr or keeps it for the `--json` document. */
  readonly warn: (finding: Finding) => void;
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
    conditions,
    concurrency,
    repeat,
    selected,
    flatPickles,
    onRecord,
    progress,
    warn,
    stderr,
  } = options;
  const warnings = (code: string): WritableSink => warningSink(code, warn);

  const hasPickles = flatPickles.length > 0;
  const expectedRecords = flatPickles.length * repeat * conditions.length;

  const pickleByKey = new Map<string, { readonly feature: SelectedFeature; readonly pickle: Pickle }>();
  for (const entry of flatPickles) {
    pickleByKey.set(pickleKey(entry.feature.relativePath, entry.pickle.location?.line ?? 0), entry);
  }

  let allPassed = true;
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
  function relayNote(text: string): void {
    const parsed = parseFindings(text);
    if (parsed.length === 0) {
      warn({ severity: "warning", code: "worker-output-unreadable", message: text });
      return;
    }
    for (const finding of parsed) {
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

  function handleEnvelope(envelope: WorkerEnvelope, filesWithRecords: Set<string>, worker: number): void {
    if (envelope.kind === "note") {
      relayNote(envelope.text);
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
    completedCount += 1;

    scenariosWritten += 1;
    if (record.status === "passed") {
      scenariosPassed += 1;
    } else {
      allPassed = false;
      failedScenarios.push(failedScenarioOf(record));
    }
    if (repeat > 1) repeatTally.note(record);
    stepRecordsWritten += record.steps.filter((step) => step.step_record_id !== null).length;
    onRecord(record);

    writeScenarioBoundary(progress, {
      index: completedCount,
      total: expectedRecords,
      relativeFeaturePath: record.feature,
      line: record.line,
      name: record.scenario,
    });
    for (const line of stepLines) {
      progress.write(`${line}\n`);
    }
    for (const note of notes) relayNote(note);

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

  async function runWorkerGroup(files: readonly SelectedFeature[], worker: number, envArg: string | null): Promise<WorkerGroupResult> {
    const filesWithRecords = new Set<string>();
    if (interruptedBy !== null) {
      return { exitCode: exitCodeForSignal(interruptedBy), filesWithRecords };
    }
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nukadoko-run-"));
    const featureListPath = path.join(tmpDir, "features.txt");
    try {
      const featureTargets = files.flatMap((feature) =>
        feature.selectedLines === null
          ? [feature.relativePath]
          : feature.selectedLines.map((line) => `${feature.relativePath}:${line}`),
      );
      await writeFile(featureListPath, `${featureTargets.join("\n")}\n`, "utf8");
      // A signal can arrive during the two awaits above.
      if (interruptedBy !== null) {
        return { exitCode: exitCodeForSignal(interruptedBy), filesWithRecords };
      }
      const child = spawnRunWorker({ rootDir, runId, env: envArg, featureListPath, repeat });
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
        handleEnvelope(envelope, filesWithRecords, worker);
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

  const parallelFeatures = selected.features.filter((feature) => !isSerialFeature(feature));
  const serialFeatures = selected.features.filter(isSerialFeature);

  const failedFiles = new Set<string>();

  const onSignal = (signal: NodeJS.Signals): void => {
    if (process.platform !== "win32") {
      for (const child of liveWorkers) child.kill(signal);
    }
    if (interruptedBy !== null) process.exit(exitCodeForSignal(signal));
    interruptedBy = signal;
  };
  for (const signal of HANDLED_SIGNALS) process.on(signal, onSignal);
  try {
    for (const condition of conditions) {
      // A signal stops the run before the next environment starts.
      if (interruptedBy !== null) break;
      if (conditions.length > 1) progress.write(`environment ${condition.environment}\n`);
      currentEnvironment = condition.environment;
      await runCondition(condition.envArg);
    }
  } finally {
    for (const signal of HANDLED_SIGNALS) process.off(signal, onSignal);
  }

  async function runCondition(envArg: string | null): Promise<void> {
    const workerCount = Math.min(concurrency, parallelFeatures.length);
    if (workerCount > 0) {
      const buckets: SelectedFeature[][] = Array.from({ length: workerCount }, () => []);
      parallelFeatures.forEach((feature, index) => {
        buckets[index % workerCount]!.push(feature);
      });

      const results = await Promise.all(buckets.map((bucket, bucketIndex) => runWorkerGroup(bucket, bucketIndex + 1, envArg)));
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
      const result = await runWorkerGroup([feature], 1, envArg);
      if (result.exitCode !== 0 && !result.filesWithRecords.has(feature.relativePath)) {
        failedFiles.add(envArg === null ? feature.relativePath : `${feature.relativePath} (${envArg})`);
      }
    }
  }

  if (interruptedBy !== null) {
    warn({
      severity: "failed",
      code: "run-incomplete",
      message:
        scenariosWritten === expectedRecords
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
  } else if (scenariosWritten !== expectedRecords) {
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
        `${conditions.length > 1 ? ` in each of ${conditions.length} environments` : ""} ` +
        `and wrote ${scenariosWritten} records. ` +
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
