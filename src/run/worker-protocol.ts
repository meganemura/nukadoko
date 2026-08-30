import type { ScenarioRecord } from "./record-types.js";

// Responsibility: the private contract between src/run/run-concurrent.ts
// (the parent, spawned by `nuka run --concurrency <n>`) and src/run/
// run-worker-entry.ts (one worker's own process entry point). Never part of
// nukadoko's own CLI surface — a user never invokes the worker entry
// directly, the same "private, positional argv" status src/live/
// daemon-entry.ts already has for `nuka session start`'s own child.
//
// A worker cannot hand the parent its bindings, its fixture graph, or
// anything else that closes over a function: none of that crosses a process
// boundary. So a worker re-derives its own config/vocabulary/bindings from
// `rootDir` (see run-worker-entry.ts's own header) and reports back only
// plain data, over its own stdout, as one JSON object per line:
//
//   { "kind": "scenario", "record": ScenarioRecord, "stepLines": string[], "notes": string[] }
//   { "kind": "note", "text": string }
//
// Argv contract (never yargs — this is not a CLI command):
//   <rootDir> <runId> <env|""> <quiet:0|1> <featureListPath>
// `featureListPath` names a temp file, one repo-relative `.feature` path per
// line, in the exact order this worker should run them.
//
// Framing choice, decided once here rather than reargued at each call site:
// both a finished scenario's own record *and* its progress text ride the
// worker's stdout, as typed envelope lines, never the worker's real stderr.
// stdout already needs exact line reassembly the moment more than one
// worker exists (src/run/line-buffer.ts's own header: a chunk boundary has
// no relation to a JSON object's own boundary), so every worker-to-parent
// signal reuses that one reassembly point instead of building a second one
// against the worker's stderr, which is exactly as vulnerable to
// mid-message chunking and would otherwise need its own terminator
// convention. A worker's own *real* stderr is left for whatever Node itself
// writes there on an uncaught, pre-try/catch crash (a stack trace this
// process never got the chance to turn into a "note" line) — the parent
// still relays that, raw, for diagnosis, but never parses it.
//
// `"scenario"` bundles everything one finished pickle produced: the record
// itself, the per-step progress lines src/run/progress-log.ts's
// `createStepProgressLogger` would have written directly to stderr under
// `--concurrency 1` (already fully rendered text, empty under `--quiet`,
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
// straight to stderr under `--concurrency 1`: a version-probe warning, an
// Allure emitter setup failure, a BeforeAll/AfterAll failure. None of these
// are scoped to one scenario, so they carry no completion-order index and
// the parent simply relays the text as its own stderr line, unconditional
// on `--quiet` exactly as `nuka run` already treats each of them today.

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

export type WorkerEnvelope = WorkerScenarioEnvelope | WorkerNoteEnvelope;

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
  if (kind === "scenario" || kind === "note") {
    return parsed as WorkerEnvelope;
  }
  return undefined;
}
