import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseFindings, type Finding } from "../finding/finding.js";
import { STOP_GRACE_MS } from "../program/world.js";
import { serializeWorldView, type WorldView } from "../program/world-view.js";
import type { ScenarioRecord } from "../record/scenario-record.js";
import { createLineBuffer } from "../sink/line-buffer.js";
import type { WritableSink } from "../sink/writable-sink.js";
import { writeProofRunBoundary } from "./progress-log.js";
import { spawnRunWorker } from "./spawn-run-worker.js";
import { projectRelativeText } from "./trees.js";
import { parseWorkerEnvelope, type HeadSecretSources, type WorkerEnvelope, type WorkerTree } from "./worker-protocol.js";

export type { HeadSecretSources } from "./worker-protocol.js";

// Responsibility: one pass of `nuka run --base` in the base or the old tree
// (docs/spec.md "Verdicts"): the cells of one world and environment, and
// the base world's rows for paths alone, run in worker processes started
// in the tree, then the cells' proof runs. Boundary:
// which cells a pass runs, the world it runs against, and what the records
// mean are the caller's (src/cli/run.ts, src/run/verdict-table.ts); this
// module runs the targets it is given and hands each record on.
//
// Always in workers, at any `--concurrency`: a tree's step files are not
// head's, and the parent has already imported head's, so they load in a
// process of their own (src/run/run-worker-entry.ts, which also checks
// them). Each worker starts in the tree's project root, so a step that
// names a path relative to it reaches the tree's files, the tree's own
// program code among them. Its records go to head's run, so run.json and
// the summary find them where they find head's.
//
// What goes wrong in a tree is the table's to say, not a failure of the
// run: a tree whose files do not load, or a BeforeAll hook that fails, is
// the reason its cells did not run, and the rows decide whether that turns
// the gate red.
//
// A worker's files (its target list, its world, its tree) are written in
// the run directory, not the system's temporary directory, so nothing a
// pass writes is outside the run. On a signal the caller stops the
// workers with `stopTreeWorkers` before it stops the tree's world and
// removes the trees: a worker busy in a step cannot run its own signal
// handler, and one left running would outlive nukadoko and its tree. So a worker's findings are relayed as warnings that name
// the tree, and a worker that exits without a record leaves cells that did
// not run, with that reason, instead of the `run-incomplete` failure a
// worker of head's pass reports.

/** One cell's execution to run: a scenario of the tree's own feature file,
 * by its line there. */
export interface TreeTarget {
  readonly feature: string;
  readonly line: number;
  /** The feature file carries `@nukadoko:serial`, so it runs alone. */
  readonly serial: boolean;
  /** The base world runs it for run.json's `paths` alone: no cell, no
   * proof runs, and a scenario line that says so. */
  readonly forPaths?: true;
}

export interface TreePassOptions {
  readonly world: "base" | "old";
  /** The tree's project root. */
  readonly treeRoot: string;
  readonly headRoot: string;
  readonly headStateDir: string;
  readonly headSecrets: HeadSecretSources;
  readonly runId: string;
  /** `--env`'s name for the environment, or `null` for the implicit
   * `default`. */
  readonly envArg: string | null;
  readonly environment: string;
  /** `false` under `--no-check`. */
  readonly check: boolean;
  readonly concurrency: number;
  readonly targets: readonly TreeTarget[];
  /** The world the pass runs against, or `null` for a tree with no
   * program file. */
  readonly view: WorldView | null;
  /** Whether a target runs once more for proof (src/run/verdict-table.ts's
   * `needsProofRun`), from the records `onRecord` heard. */
  readonly needsProof: (feature: string, line: number) => boolean;
  /** How many executions a target's cell holds so far. */
  readonly runsOf: (feature: string, line: number) => number;
  readonly proofRuns: number;
  readonly onRecord: (record: ScenarioRecord) => void;
  readonly progress: WritableSink;
  readonly warn: (finding: Finding) => void;
  /** A worker's own stderr, relayed raw. */
  readonly stderr: WritableSink;
  /** Every worker while it runs, so the caller can stop them on a
   * signal (`stopTreeWorkers`). */
  readonly live: Set<ChildProcess>;
  /** The run directory, absolute: each worker's files are written in it. */
  readonly runDir: string;
}

// Each worker has a process group of its own on POSIX (src/run/
// spawn-run-worker.ts), so a signal to the group reaches a process a step
// started too.
const groups = process.platform !== "win32";

function signalWorker(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (groups && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The group is gone already: nothing is left to signal.
  }
}

/** Stops every worker in `live`: SIGTERM, the grace period a world's
 * group gets, then SIGKILL to whatever is left. Resolves once that is
 * done. */
export async function stopTreeWorkers(live: ReadonlySet<ChildProcess>): Promise<void> {
  const workers = [...live];
  for (const child of workers) signalWorker(child, "SIGTERM");
  const running = (): boolean => workers.some((child) => child.exitCode === null && child.signalCode === null);
  const deadline = Date.now() + STOP_GRACE_MS;
  while (running() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  for (const child of workers) signalWorker(child, "SIGKILL");
}

export interface TreePassResult {
  /** Why some of the pass's cells did not run, when the pass knows: its
   * tree did not load or check, a BeforeAll hook failed, or a worker
   * exited without a record. `null` when every target has a record. */
  readonly notRun: string | null;
}

function label(world: "base" | "old", environment: string): string {
  return `${world} ${environment}`;
}

/** Runs `options.targets` in the tree, then their proof rounds. Never
 * throws for what a worker does; the result says what did not run. */
export async function runTreePass(options: TreePassOptions): Promise<TreePassResult> {
  const { world, environment, progress } = options;
  // Held in an object: the handlers below set it, and a plain `let` would
  // read as never set after them.
  const state: { notRun: string | null } = { notRun: null };
  const where = `the ${world} tree in ${environment}`;

  // A tree's worker names its files by their absolute paths, under the
  // run directory; what nukadoko prints names them from the project root.
  const shown = (text: string): string => projectRelativeText(text, options.headRoot);
  const relay = (text: string): void => {
    const parsed = parseFindings(text);
    if (parsed.length === 0) {
      options.warn({ severity: "warning", code: "worker-output-unreadable", message: shown(`${where}: ${text}`) });
      return;
    }
    // A warning, whatever the worker's severity: the table decides whether
    // what went wrong in a tree turns the gate red (module header).
    for (const finding of parsed) {
      options.warn({ severity: "warning", code: finding.code, message: shown(`${where}: ${finding.message}`), ...(finding.fix === undefined ? {} : { fix: shown(finding.fix) }) });
    }
  };

  const forPaths = new Set(options.targets.filter((target) => target.forPaths === true).map((target) => `${target.feature}:${target.line}`));
  const handle = (envelope: WorkerEnvelope, proofRound: boolean, seen: Set<string>): void => {
    if (envelope.kind === "note") return relay(envelope.text);
    if (envelope.kind === "not-run") {
      state.notRun ??= shown(envelope.reason);
      return;
    }
    if (envelope.kind === "before-all-failed") {
      state.notRun ??= `a BeforeAll hook failed in ${where}`;
      return;
    }
    if (envelope.kind === "scenario-started") {
      if (!proofRound) progress.write(`${label(world, environment)}  ${envelope.feature}:${envelope.line}  ${envelope.name}${forPaths.has(`${envelope.feature}:${envelope.line}`) ? "  (for paths)" : ""}\n`);
      return;
    }
    const { record, stepLines, notes } = envelope;
    seen.add(`${record.feature}:${record.line}`);
    options.onRecord(record);
    if (proofRound) {
      writeProofRunBoundary(progress, {
        relativeFeaturePath: record.feature,
        line: record.line,
        name: record.scenario,
        environment,
        run: options.runsOf(record.feature, record.line),
        of: options.proofRuns,
        where: world,
      });
    }
    for (const line of stepLines) progress.write(`${line}\n`);
    for (const note of notes) relay(note);
  };

  const runGroup = async (targets: readonly TreeTarget[], proofRound: boolean): Promise<number> => {
    const seen = new Set<string>();
    const tmpDir = await mkdtemp(path.join(options.runDir, ".tree-pass-"));
    try {
      const featureListPath = path.join(tmpDir, "features.txt");
      await writeFile(featureListPath, `${targets.map((target) => `${target.feature}:${target.line}`).join("\n")}\n`, "utf8");
      const treePath = path.join(tmpDir, "tree.json");
      const tree: WorkerTree = { world, headRoot: options.headRoot, headStateDir: options.headStateDir, check: options.check, headSecrets: options.headSecrets };
      await writeFile(treePath, JSON.stringify(tree), "utf8");
      const worldPath = options.view === null ? null : path.join(tmpDir, "world.json");
      if (worldPath !== null && options.view !== null) await writeFile(worldPath, serializeWorldView(options.view), "utf8");
      const child = spawnRunWorker({
        rootDir: options.treeRoot,
        runId: options.runId,
        env: options.envArg,
        featureListPath,
        repeat: 1,
        worldPath,
        treePath,
        cwd: options.treeRoot,
      });
      options.live.add(child);
      const stdoutBuffer = createLineBuffer((line) => {
        if (line.length === 0) return;
        const envelope = parseWorkerEnvelope(line);
        if (envelope === undefined) {
          options.warn({ severity: "warning", code: "worker-output-unreadable", message: shown(`${where}: a worker produced an unreadable line on its own stdout: ${line}`) });
          return;
        }
        handle(envelope, proofRound, seen);
      });
      const stderrBuffer = createLineBuffer((line) => {
        if (line.length > 0) options.stderr.write(`${line}\n`);
      });
      child.stdout.on("data", (chunk: Buffer) => stdoutBuffer.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrBuffer.push(chunk));
      // `close`, after every stdio stream ended, so no record still in
      // flight is missed (src/run/run-concurrent.ts says the same).
      const exitCode = await new Promise<number>((resolve) => {
        let settled = false;
        const finish = (code: number): void => {
          if (settled) return;
          settled = true;
          resolve(code);
        };
        child.once("close", (code) => finish(code ?? 1));
        child.once("error", () => finish(1));
      });
      options.live.delete(child);
      stdoutBuffer.flush();
      stderrBuffer.flush();
      const missing = targets.filter((target) => !seen.has(`${target.feature}:${target.line}`));
      if (missing.length > 0 && state.notRun === null && exitCode !== 0) {
        state.notRun = `the worker that ran it in ${where} exited with code ${exitCode} before it wrote a record`;
      }
      return seen.size;
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  };

  // Whole feature files per worker, as head's pass hands them out, so a
  // `@nukadoko:serial` file still runs alone, after the others.
  const byFile = new Map<string, TreeTarget[]>();
  for (const target of options.targets) byFile.set(target.feature, [...(byFile.get(target.feature) ?? []), target]);
  const parallel = [...byFile.values()].filter((group) => !group[0]!.serial);
  const serial = [...byFile.values()].filter((group) => group[0]!.serial);
  const workerCount = Math.min(Math.max(1, options.concurrency), parallel.length);
  if (workerCount > 0) {
    const buckets: TreeTarget[][] = Array.from({ length: workerCount }, () => []);
    parallel.forEach((group, index) => buckets[index % workerCount]!.push(...group));
    await Promise.all(buckets.map((bucket) => runGroup(bucket, false)));
  }
  for (const group of serial) await runGroup(group, false);

  // One round at a time, so a cell stops at the first run that disagrees.
  // A round that wrote fewer records than it was given ends the rounds:
  // the cells it left out would be due again forever.
  for (;;) {
    if (state.notRun !== null) break;
    const due = options.targets.filter((target) => options.needsProof(target.feature, target.line));
    if (due.length === 0) break;
    const written = await runGroup(due, true);
    if (written < due.length) break;
  }
  return { notRun: state.notRun };
}
