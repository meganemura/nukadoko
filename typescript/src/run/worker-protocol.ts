import type { ScenarioRecord } from "../record/scenario-record.js";

// Responsibility: the private contract between src/run/run-concurrent.ts
// (the parent, spawned by `nuka run --concurrency <n>`) and src/run/
// run-worker-entry.ts (one worker's own process entry point). Never part of
// nukadoko's own CLI surface — a user never invokes the worker entry
// directly: its argv is private and positional.
//
// A worker cannot hand the parent its bindings, its fixture graph, or
// anything else that closes over a function: none of that crosses a process
// boundary. So a worker re-derives its own config/vocabulary/bindings from
// `rootDir` (see run-worker-entry.ts's own header) and reports back only
// plain data, over its own stdout, as one JSON object per line:
//
//   { "kind": "scenario-started", "feature": string, "line": number, "name": string }
//   { "kind": "scenario", "record": ScenarioRecord, "stepLines": string[], "notes": string[] }
//   { "kind": "note", "text": string }
//   { "kind": "not-run", "reason": string }
//
// Argv contract (never yargs — this is not a CLI command):
//   <rootDir> <runId> <env|""> <featureListPath> <repeat> <worldPath|""> <treePath|"">
// `featureListPath` names a temp file, one repo-relative `.feature` path per
// line, in the exact order this worker should run them. `repeat` is how
// many times the worker runs that whole list (`nuka run --repeat`), a
// whole number of 1 or more that the parent has already validated.
// `worldPath` names a temp file holding the world the parent started for
// this pass (src/program/world-view.ts), or is empty when the tree has no
// program file. The parent owns the program: every worker of a pass sends
// its requests to the one server the parent started. `treePath` names a
// temp file holding a `WorkerTree` when the worker runs a pass in a tree
// of `nuka run --base` (src/run/tree-pass.ts), or is empty.
//
// Framing choice, decided once here rather than reargued at each call site:
// both a finished scenario's own record *and* its progress text ride the
// worker's stdout, as typed envelope lines, never the worker's real stderr.
// stdout already needs exact line reassembly the moment more than one
// worker exists (src/sink/line-buffer.ts's own header: a chunk boundary has
// no relation to a JSON object's own boundary), so every worker-to-parent
// signal reuses that one reassembly point instead of building a second one
// against the worker's stderr, which is exactly as vulnerable to
// mid-message chunking and would otherwise need its own terminator
// convention. A worker's own *real* stderr is left for whatever Node itself
// writes there on an uncaught, pre-try/catch crash (a stack trace this
// process never got the chance to turn into a "note" line), and for what
// project code writes to `process.stdout` (src/run/step-stdout.ts). The
// parent still relays that, raw, but never parses it.
//
// `"scenario"` bundles everything one finished pickle produced: the record
// itself, the per-step progress lines src/run/progress-log.ts's
// `createStepProgressLogger` would have written directly to stderr under
// `--concurrency 1` (already fully rendered text,
// since a step's own "N/total" numbering is local to its scenario and needs
// no renumbering the way a scenario boundary line's own index does), and
// any fixture-teardown warning that scenario's own execution produced
// (`ScenarioRecord.teardown_errors`, pre-rendered the same way `nuka run`
// already words it at concurrency 1). The parent is what turns this bundle
// into a scenario-boundary line carrying its own completion-order index
// (docs/spec.md "Scenarios (the scripted path)": "the records land in the
// order the workers finish"), something a worker cannot compute for itself
// since it only ever sees its own slice of the whole run's pickles.
//
// `"note"` is every other single line a worker would otherwise have written
// straight to stderr under `--concurrency 1`: a version-probe warning or a
// BeforeAll/AfterAll failure. None of these
// are scoped to one scenario, so they carry no completion-order index and
// the parent simply relays the text as its own stderr line.

/** Sent the moment a worker begins one pickle, before its first step runs.
 * The parent turns it into the one line that says what is running now
 * (src/run/progress-log.ts's `writeScenarioStarted`): without it, the
 * parent's only signal about a scenario arrives when that scenario ends,
 * so a run that hangs leaves a log whose last line names the scenario
 * before the one that hung. Carries no index — the parent numbers
 * completions, not starts (that file's own comment). */
export interface WorkerScenarioStartedEnvelope {
  readonly kind: "scenario-started";
  readonly feature: string;
  readonly line: number;
  readonly name: string;
}

export interface WorkerScenarioEnvelope {
  readonly kind: "scenario";
  readonly record: ScenarioRecord;
  readonly stepLines: readonly string[];
  readonly notes: readonly string[];
}

export interface WorkerNoteEnvelope {
  readonly kind: "note";
  readonly text: string;
}

/** Sent after the note when a BeforeAll hook failed, so none of this
 * worker's scenarios ran. The parent's verdict table says why their cells
 * did not run (docs/spec.md "Verdicts"); a note's text is for a person,
 * and the table does not read it back. */
export interface WorkerBeforeAllFailedEnvelope {
  readonly kind: "before-all-failed";
}

/** Sent instead of any scenario by a worker in a tree whose config,
 * program file, or step files do not load or check: nothing of the pass
 * ran, and `reason` says why, for every cell the pass was to fill. */
export interface WorkerNotRunEnvelope {
  readonly kind: "not-run";
  readonly reason: string;
}

export type WorkerEnvelope =
  | WorkerScenarioStartedEnvelope
  | WorkerScenarioEnvelope
  | WorkerNoteEnvelope
  | WorkerBeforeAllFailedEnvelope
  | WorkerNotRunEnvelope;

/** What a worker in a tree of `nuka run --base` needs beyond its tree's
 * root: head's root and state directory, where the run's records go and
 * where the env files are read (they are the environment's, untracked,
 * and no tree holds them), and whether `nuka check` runs over the
 * tree's selection first. */
export interface WorkerTree {
  readonly world: "base" | "old";
  readonly headRoot: string;
  readonly headStateDir: string;
  readonly check: boolean;
  /** What head's secret set for the environment is built from. */
  readonly headSecrets: HeadSecretSources;
}

/** Head's env files for an environment and its config's `secrets.public`
 * and `secrets.redact`: names only, so the file that carries them holds
 * no value. A tree's worker redacts with the set they build as well as
 * with its own, since the tree's config (the ref's, in the old world)
 * must not decide which of head's values may print. */
export interface HeadSecretSources {
  readonly envFiles: readonly string[];
  readonly publicKeys: readonly string[];
  readonly redactKeys: readonly string[];
}

export function serializeWorkerEnvelope(envelope: WorkerEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

/** `undefined` for a line that isn't a well-formed envelope (malformed
 * JSON, or JSON missing the shape this module owns) — the caller's problem
 * to report, never this function's to throw over: a corrupted line from one
 * worker must not take down the parent process reading every worker's
 * output. */
export function parseWorkerEnvelope(line: string): WorkerEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const kind = (parsed as { kind?: unknown }).kind;
  if (kind === "scenario-started" || kind === "scenario" || kind === "note" || kind === "before-all-failed" || kind === "not-run") {
    return parsed as WorkerEnvelope;
  }
  return undefined;
}
