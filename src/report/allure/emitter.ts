import path from "node:path";
import { Status, type StepResult, type TestResult } from "allure-js-commons";
import type { Category, EnvironmentInfo } from "allure-js-commons/sdk";
import {
  ReporterRuntime,
  createStepResult,
  createTestResult,
  getEnvironmentLabels,
  getFrameworkLabel,
  getHostLabel,
  getLanguageLabel,
  getTestResultHistoryId,
  getTestResultTestCaseId,
  getThreadLabel,
  randomUuid,
} from "allure-js-commons/sdk/reporter";
import type { GherkinDocument, Pickle } from "@cucumber/messages";
import type { WritableSink } from "../../cli/writable-sink.js";
import type { StepRecord } from "../../record/types.js";
import type { ScenarioRecord, ScenarioStepRecord } from "../../run/record-types.js";
import { redactString } from "../../secrets/redact.js";
import type { SecretSet } from "../../secrets/types.js";
import { buildCategories } from "./categories.js";
import { buildFullName, buildTitlePath, resolveProjectName, toPosixPath } from "./identity.js";
import {
  buildExampleParameters,
  buildScenarioStepsSignature,
  buildStepName,
  firstFailure,
  mapGwtStep,
  mapHooks,
  mapScenario,
  type MappedAttachment,
  type MappedChildStep,
  type MappedGwtStep,
  type MappedGwtStepOutcome,
  type MappedHook,
  type MappedParameter,
  type MappedScenarioTest,
  type MappedStatus,
} from "./map-scenario.js";
import { createAtomicWriter } from "./writer.js";

// Responsibility: the thin layer that turns map-scenario.ts's flat
// description into actual `ReporterRuntime` calls — the only module in this
// directory that imports allure-js-commons for its running behavior
// (categories.ts/writer.ts also import it, but only for static Category/
// Writer plumbing) and the only one that touches the filesystem beyond what
// the `Writer` itself does (resolving the project name).
//
// One pickle, one Allure test result, written once — at `endScenario`, never
// per step. `beginScenario` opens this scenario's own Allure *scope* and
// clears this module's own step buffer before its first step can possibly
// run; `emitStep` maps that one step (map-scenario.ts's own `mapGwtStep`)
// and appends the result to the buffer — its only I/O is the progress
// snapshot this file's own header below describes, never the real result
// itself; `endScenario` folds the whole buffer into one `steps[]` array
// (map-scenario.ts's own `mapScenario`), maps this scenario's own hooks into
// fixtures under the same scope, writes the one test, and only then writes
// the scope's own container (`writeScope`). A step that never runs a real
// body (never-began, skipped by an earlier failure) still gets its own
// `emitStep` call and its own `steps[]` entry — `run-scenario.ts`'s own
// `pushStepRecord` is the one place that appends to `record.steps` and
// calls this, so every element of that array gets exactly one call, in
// order, with no gaps.
//
// This module holds state across `beginScenario`/`emitStep`/`endScenario`
// (`currentScopeUuid`, the step buffer, and the progress-snapshot state
// below) — safe because one `createAllureEmitter()` instance lives in one
// process, and that process (the whole invocation at `--concurrency 1`, one
// worker above it) executes its own scenarios strictly sequentially, never
// two at once. `--concurrency <n>` gives every worker its own instance of
// this module's own state, never one shared across them.
//
// **A bad attachment now costs the whole scenario's own Allure result, not
// just one step's.** Every `writeAttachment` call for every step, every
// result-level attachment, and the final `writeTest` all happen inside one
// `try` block at `endScenario` — when everything used to be its own test
// (before this design), a broken reference in step 2 only lost step 2's own
// file; now that a scenario is one result, the same failure loses the
// scenario's entire Allure output (`record.json` on disk, the actual source
// of truth, is unaffected either way). Accepted rather than fixed with a
// second, per-attachment try/catch: the damage unit was always "one test",
// and one test is now the whole scenario.
//
// A Before hook's own failure still leaves every step it stops from ever
// running reported `"skipped"`, never `"failed"` — the failure itself is
// visible in that Before fixture's own detail view. The result's own status
// is `record.status` directly, which the scenario record already sets to
// `"failed"` whenever any of its steps didn't pass (record-types.ts), and
// map-scenario.ts's own `firstFailure` search falls back to a classified
// hook failure exactly for this case, so a Before-hook-stopped scenario
// still lands in one of `nuka init`'s own seven categories instead of
// Allure 3's uninformative "Product errors" catch-all.
//
// Known limit: record.json carries no per-hook timestamp of its own, so
// every before-hook collapses to the scenario's own `started_at` and every
// after-hook to its `finished_at`, both zero-width (map-scenario.ts's own
// `mapHooks`).
//
// AllureEmitterOptions carries no `stateDir` of its own: a step's own step
// record is handed to `emitStep` directly by the caller (cli/run.ts,
// threaded from run-scenario.ts's own `onStepFinished`) — this emitter
// never reads a record.json off disk itself, unlike the messages emitter
// (src/report/messages/emitter.ts), which still does via
// src/report/step-records.ts's `readStepRecordsForScenario`.
//
// Beyond that one real result, `beginScenario`, every `emitStep`, and every
// heartbeat tick's own `emitStepProgress` (this file's own header, further
// down) all write a disposable *progress* snapshot, never a substitute for
// the real result, never itself the record `record.json` on disk already
// is. Every snapshot in one scenario writes under that same scenario's own uuid,
// generated once in `beginScenario` and reused for every later snapshot,
// but always under a fresh file name (writer.ts's own
// `writeProgressSnapshot`, `<uuid>-<sequence>-progress-result.json`)
// because `allure watch` only ever discovers a genuinely new file path
// (polls every 300ms, ignores an overwrite of a path it already read;
// verified against @allurereport/core 3.14.3, the version this repository
// pins), so updating one file in place would only ever be seen once. The
// uuid stays fixed because @allurereport/core's own `convert.js` builds a
// detail page's route as `md5(uuid)`: a fresh uuid per snapshot would be a
// fresh route per snapshot, and the live channel `allure watch` serves that
// page over is a whole-page reload (the static server injects an
// `EventSource` whose handler calls `window.location.reload()`) that keeps
// the URL fragment, so a page reloading onto its own route only ever comes
// back to where it already was. One fixed uuid per scenario is what lets a
// page left open on that route keep showing whatever landed there most
// recently, reload after reload. Every snapshot still carries the exact
// same `fullName`/`testCaseId`/`historyId`/non-excluded parameters the
// eventual real result will (map-scenario.ts's own
// `buildScenarioStepsSignature`/`buildExampleParameters`, both read
// straight off `pickle`, frozen before a single step runs), computed with
// allure-js-commons' own `getTestResultTestCaseId`/`getTestResultHistoryId`,
// the same formula `ReporterRuntime.stopTest` itself calls for the real
// result, never reimplemented here. That shared identity is what makes
// `allure`'s own retry merge (@allurereport/core 3.14.3's `RetrySubstore`)
// treat every snapshot and the eventual real result as retries of one same
// test, picking whichever has the highest `start` as canonical. The key
// that merge groups on is `retryHash`, `md5` over `testCaseId`, the
// non-excluded parameters, and the environment id (`store.js`'s own
// `calculateRetryHash` call), never the uuid, so that grouping and the uuid
// scheme below are independent of each other. `historyId` rides along on
// every snapshot for history and known-issue matching, and takes no part in
// the grouping.
//
// `RetrySubstore.compareResults` (source read directly, 3.14.3) falls back
// to ingest order only when two results tie on `start`; whenever `start`
// differs, the higher one wins outright. This module never relies on that
// fallback: `beginScenario` gives every progress snapshot a `start`
// strictly higher than the one before it in the same scenario (each
// `writeProgressSnapshot` call below adds one to the last), so within one
// scenario `start` alone always picks a canonical result, and the real
// result's own `start` (`record.started_at` itself) is set above every
// snapshot's ceiling, so it always outranks all of them.
//
// That strictly-increasing `start` now carries a second job beyond picking
// a canonical result: keeping the running scenario list from going empty.
// Every snapshot in a scenario resolves to the same store id, so
// `recordIngestOrder` records that id's own ingest position once, at the
// first snapshot ever seen under it, and every later write under the same
// uuid reads back that same recorded position. If two of a scenario's own
// snapshots ever tied on `start`, `RetrySubstore.compareResults` would fall
// back to that shared ingest position for both sides of the comparison and
// return 0; a stable sort leaves tied entries in their original order, so
// the earliest snapshot would keep the canonical slot for good and every
// later one, including whichever snapshot the run had actually reached,
// would be marked a retry and drop out of the list. `beginScenario`'s own
// `start` formula (just below) and each `writeProgressSnapshot` call's own
// `+ 1` over the last are what keep that tie from happening today. The two
// mechanisms now travel as a pair: reusing one uuid across a scenario's
// snapshots only stays safe as long as their `start` keeps climbing, so a
// change to that formula that lets two snapshots tie reopens the
// empty-list failure this paragraph describes, even though nothing about
// the uuid scheme itself changed.
//
// `beginScenario`'s own formula used to budget one snapshot write per step
// (`scenarioStart - (steps.length + 2)`): `beginScenario` writes one, and
// each step's own `emitStep` writes exactly one more, so a scenario of N
// steps made N + 1 calls to `writeProgressSnapshot` in total, and the old
// anchor left exactly that much room below `ceiling` before `Math.min`'s
// clamp could ever collapse two of them onto the same `start`. A step's own
// heartbeat (src/run/run-scenario.ts's `runWithHeartbeat`) breaks that
// one-write-per-step assumption: a step still running past its own first
// tick calls `emitStepProgress` too, up to `heartbeatCap` times, before its
// own `emitStep` ever lands, so one step can now account for as many as
// `heartbeatCap + 1` writes, not one. The anchor below budgets for exactly
// that worst case, per step (`steps.length * (heartbeatCap + 1) + 2`): the
// `+ 1` inside covers each step's own `emitStep`, the `* steps.length`
// covers every step needing its own full heartbeat budget, and the `+ 2`
// at the end is `beginScenario`'s own initial write plus one spare
// millisecond of headroom, the same margin the old formula already kept.
// An on-budget run, one where no step's own heartbeat ever reaches
// `heartbeatCap`, writes far fewer than this budget allows, exactly the
// way the old formula's own N + 1 was a ceiling, not an expectation, for
// every scenario that never needed the `Math.min` clamp at all.
//
// This matters because ingest order does not track write order on every
// path that reads `allure-results`. `allure watch`'s own live path does
// track it, but the batch path `allure generate` uses, `readDirectory`,
// lists the directory with `entries.sort((a, b) =>
// a.name.localeCompare(b.name))`, an alphabetical sort on each result
// file's own name, then reads every file concurrently through a
// limited-concurrency pool, so its own ingest order tracks neither the
// write order nor that alphabetical listing. Seven real progress snapshots
// of one seven-step scenario were captured mid-run and replayed against
// that batch path, back when every one of them still shared a single
// `start`: ingested in reverse write order, the canonical result showed 0
// of the 7 steps resolved, and ingested in the batch path's own
// alphabetical order it showed 4 of the 7. Which snapshot won tracked the
// ingest order it was fed, never how far the run had actually got.
//
// `endScenario` deletes every progress snapshot the scenario ever wrote the
// moment its real result lands, so a finished run's own `allure-results`
// directory never carries a stale one; `begin()` sweeps up whatever a
// previous run's own crash left behind, the same moment it (re)writes
// categories.json/environment.properties.
//
// @allurereport/reader reads a result's uuid out of its JSON body, never
// off the file name (measured against 3.14.3 at the file layer: three
// snapshots sharing one uuid produce a single
// `data/test-results/<md5(uuid)>.json`, rewritten in place, carrying the
// newest content, on a route that never moves), which is what makes one
// fixed uuid per scenario, arriving under a fresh file name each time,
// enough for the new-paths-only watcher above. Two things ride along with
// that choice, both already true of what `RetrySubstore` does regardless of
// which uuid scheme this module picks: `upsert` appends on every ingest
// without checking whether an id is already in its group, so the retry
// listing still carries the scenario's id once per snapshot it wrote, the
// same row count the old, one-uuid-per-snapshot scheme already produced,
// now all pointing at the one page instead of a different page each. And a
// real result that reused a snapshot's own uuid would collapse onto that
// snapshot's store id, where the winner is decided by file read order
// rather than by `start`; `partialTest` below never sets a `uuid` field of
// its own, so `ReporterRuntime.startTest` always generates the real
// result's uuid independently, and it never collides with a snapshot's.
//
// One thing a page left open on a scenario's fixed route does not do,
// measured against a real run under 3.14.3 rather than reasoned about: it
// never reaches the real result. `endScenario` writes that on a route of
// its own, and a reload keeps the URL fragment, so reaching it means
// walking in from the list again. This is the report's own behavior, not
// something this module can write its way out of.
//
// The newest snapshot that page ever shows is always whichever
// `writeProgressSnapshot` call landed last before `endScenario`'s own
// cleanup runs, inside the 300ms the watcher waits between polls. Before a
// step's own heartbeat existed, that was always `emitStep`'s own write for
// whichever step had most recently finished, so a scenario's own final step
// was invisible while it ran and only appeared once it (and every step
// after it, one at a time) had already finished. A step still running past
// its own first heartbeat tick now writes into that same window while it
// runs (`emitStepProgress`'s own doc comment below), so the final step of a
// scenario that runs long enough is no longer a gap in that page's own
// view. Only every step that finishes inside one 10-second tick still is.

export interface AllureEmitterOptions {
  /** Absolute path. */
  readonly resultsDir: string;
  readonly rootDir: string;
  readonly environment: string;
  readonly targetVersion?: string;
  readonly secrets: SecretSet;
  readonly stderr: WritableSink;
  /** How many heartbeat ticks one step's own `runWithHeartbeat`
   * (src/run/run-scenario.ts) can produce before it stops. `beginScenario`
   * needs this same number to size its own `start` budget per step (this
   * file's own header, the paragraph on `beginScenario`'s formula). Optional
   * so a caller with nothing running long enough to ever heartbeat (or an
   * existing test built before this field existed) doesn't have to state
   * it; defaults to `DEFAULT_HEARTBEAT_CAP`, the same value run-scenario.ts
   * fixes its own cap at. cli/run.ts passes run-scenario.ts's own exported
   * `HEARTBEAT_TICK_CAP` explicitly instead of relying on that default, so
   * the two numbers cannot drift apart on their own. */
  readonly heartbeatCap?: number;
}

/** `AllureEmitterOptions.heartbeatCap`'s own default. Must equal run-
 * scenario.ts's own `HEARTBEAT_TICK_CAP`; cli/run.ts always passes that
 * value explicitly (this file's own header), so this default only matters
 * for a caller that never wires the two together at all. Exported so a test
 * that does not care about the exact cap can compute the same `start`
 * budget this module does, rather than repeating the number. */
export const DEFAULT_HEARTBEAT_CAP = 120;

export interface BeginScenarioInput {
  readonly pickle: Pickle;
  readonly gherkinDocument: GherkinDocument;
  readonly relativeFeaturePath: string;
  /** Captured by the caller (cli/run.ts) once, right before `runScenario`
   * itself runs, never later than that call's own `record.started_at`
   * (nothing async happens between the two). `beginScenario` uses this
   * value as the top of the range every one of this scenario's own
   * progress snapshots gets its `start` from (this file's own header,
   * `writeProgressSnapshot`): the highest a snapshot's `start` can reach is
   * one millisecond below this value, and the real result's own `start` is
   * `record.started_at` itself, so however many milliseconds of true drift
   * separate this timestamp from `record.started_at`'s own, the real
   * result's `start` still lands at or above this value, above every
   * snapshot the scenario wrote. */
  readonly startedAt: Date;
}

export interface EmitStepInput {
  readonly runId: string;
  readonly scenarioId: string;
  readonly environment: string;
  readonly session: string | null;
  readonly targetVersion?: string;
  readonly record: ScenarioStepRecord;
  /** The exact in-memory object run-scenario.ts's own `writeStepRecord`
   * call just persisted for this step, or `null` for a step with no step
   * record of its own at all — see map-scenario.ts's `MapGwtStepInput.
   * stepRecord` for the full reasoning. */
  readonly stepRecord: StepRecord | null;
  readonly index: number;
  readonly finishedAt: Date;
  readonly gherkinDocument: GherkinDocument;
  readonly pickle: Pickle;
  readonly relativeFeaturePath: string;
}

/** One heartbeat tick for a step that is still running (src/run/run-
 * scenario.ts's `StepHeartbeatInfo`, threaded through unchanged by
 * cli/run.ts's own `onStepProgress` wiring). `liveItems` is already the
 * human-readable text run-scenario.ts built from that step's own in-flight
 * `ctx.poll` calls and `ctx.section` labels; this module never looks inside
 * either source itself, only renders the strings it is given. */
export interface EmitStepProgressInput {
  readonly scenarioId: string;
  readonly index: number;
  readonly startedAt: Date;
  readonly liveItems: readonly string[];
  readonly gherkinDocument: GherkinDocument;
  readonly pickle: Pickle;
  readonly relativeFeaturePath: string;
}

export interface EndScenarioInput {
  readonly record: ScenarioRecord;
  readonly gherkinDocument: GherkinDocument;
  readonly pickle: Pickle;
  readonly relativeFeaturePath: string;
}

export interface AllureEmitter {
  /** Writes categories.json and environment.properties, and deletes every
   * `*-progress-result.json` a previous run's own crash left behind. Once,
   * at the start of a run. */
  begin(): void;
  /** Opens this scenario's own scope, clears this module's own step
   * buffer, and writes this scenario's own initial progress snapshot —
   * every one of `input.pickle`'s own steps listed as planned, none of
   * them run yet. Never throws. */
  beginScenario(input: BeginScenarioInput): void;
  /** Maps one step, appends it to this scenario's own buffer, and writes an
   * updated progress snapshot reflecting the buffer so far — a fresh file,
   * replacing (by superseding, not overwriting: `endScenario` is what
   * deletes the old one) this scenario's own most recent snapshot.
   * `endScenario` is still what turns the whole buffer into the one real
   * Allure test. Never throws. */
  emitStep(input: EmitStepInput): void;
  /** Writes a fresh progress snapshot showing the step at `input.index` as
   * still running: no `status` at all (so it renders as `?`, the same as a
   * not-yet-started step), `stop` advanced to the moment this call runs (so
   * the reader's own missing-`stop`-means-zero-duration fallback never
   * triggers, and the shown duration keeps growing tick to tick), and
   * `input.liveItems` listed flat under its own nested `steps[]`, never
   * nested under each other, since Allure 3's own detail view collapses a
   * depth-2 child by default. A no-op when no scope is open (`beginScenario`
   * never ran or itself failed) or when the step at `input.index` has
   * already been buffered by `emitStep` (that step's own real outcome
   * always wins over a stale heartbeat; unreachable under normal operation,
   * since run-scenario.ts's own heartbeat always stops before that step's
   * `run` call it wraps even returns, kept as a defensive check rather than
   * an assumption this function bakes in). Never throws. */
  emitStepProgress(input: EmitStepProgressInput): void;
  /** Folds the buffered steps and this scenario's own hooks (and whatever
   * scenario-level evidence it collected) into one Allure test plus its own
   * fixtures, writes both, then writes the scope's own container. Deletes
   * every progress snapshot this scenario ever wrote, regardless of
   * whether the real result above wrote successfully. Never throws. */
  endScenario(input: EndScenarioInput): void;
}

function allureStatus(status: MappedStatus): Status {
  switch (status) {
    case "passed":
      return Status.PASSED;
    case "failed":
      return Status.FAILED;
    case "broken":
      return Status.BROKEN;
    case "skipped":
      return Status.SKIPPED;
  }
}

/** One already-finished child step (a declared log line, a timeline entry,
 * a call), reshaped for a progress snapshot — recurses on its own nested
 * `childSteps`, same as `emitter.ts`'s own `writeChildSteps` does for the
 * real result. `MappedChildStep` carries no attachments of its own at all
 * (its own header), so there is nothing here to strip the way
 * `mappedGwtStepToSnapshotStep`, below, has to. */
function mappedChildStepToSnapshotStep(child: MappedChildStep): StepResult {
  const result = createStepResult();
  result.name = child.name;
  result.status = allureStatus(child.status);
  result.start = child.startMs;
  result.stop = child.stopMs;
  if (child.parameters && child.parameters.length > 0) {
    result.parameters = [...child.parameters];
  }
  if (child.childSteps && child.childSteps.length > 0) {
    result.steps = child.childSteps.map(mappedChildStepToSnapshotStep);
  }
  return result;
}

/** One already-finished `steps[]` entry, reshaped for a progress snapshot:
 * every field `writeGwtSteps` (below) eventually renders for the real
 * result except attachments — a snapshot never carries one (this file's
 * own header: attachments are final-only, avoiding a duplicate,
 * possibly-still-being-copied reference racing the real result's own). */
function mappedGwtStepToSnapshotStep(step: MappedGwtStep): StepResult {
  const result = createStepResult();
  result.name = step.name;
  result.status = allureStatus(step.status);
  result.start = step.startMs;
  result.stop = step.stopMs;
  if (step.parameters.length > 0) {
    result.parameters = [...step.parameters];
  }
  if (step.childSteps.length > 0) {
    result.steps = step.childSteps.map(mappedChildStepToSnapshotStep);
  }
  return result;
}

/** One `steps[]` entry for a pickle step that has not run yet — named
 * exactly the way it will read once it actually finishes (`buildStepName`,
 * map-scenario.ts, shared with `mapGwtStep` itself), status left unset
 * (`createStepResult`'s own default), so a live viewer sees the whole plan
 * before any of it has happened. */
function plannedSnapshotStep(name: string): StepResult {
  const result = createStepResult();
  result.name = name;
  return result;
}

/** One `steps[]` entry for the pickle step a heartbeat tick caught still
 * running (`emitStepProgress`). `status` stays unset, the same
 * `createStepResult` default `plannedSnapshotStep` above already leaves
 * alone, so this renders `?` exactly like a not-yet-started step does.
 * `startMs` is this step's own real start (`StepHeartbeatInfo.startedAt`);
 * `nowMs` is the moment this tick fires, always later than the one before
 * it, which is what keeps the shown duration growing instead of reading
 * `0s` (this file's own header: a missing `stop` reads back as `stop ===
 * start`). `liveItems` are rendered through `plannedSnapshotStep` itself:
 * name only, no status, no nested children of their own, which is exactly
 * what keeps them one flat level rather than a depth-2 tree Allure's own
 * detail view would collapse by default.
 *
 * `liveItems` is the one thing this module redacts itself, against the rule
 * that everything else here arrives already redacted (this file's own
 * header: a step record is redacted once, when it is written, and never a
 * second time here). A live item has no such first pass to inherit. It is
 * built mid-step, straight off `ctx.poll`'s own `description` and
 * `ctx.section`'s own label, both of which a step composes at run time and
 * can interpolate a value into, and it lands in a file under
 * `allure-results/`. Without this call a secret in a poll description would
 * reach that file in the clear. */
function runningSnapshotStep(
  name: string,
  startMs: number,
  nowMs: number,
  liveItems: readonly string[],
  secrets: SecretSet,
): StepResult {
  const result = createStepResult();
  result.name = name;
  result.start = startMs;
  result.stop = nowMs;
  if (liveItems.length > 0) {
    result.steps = liveItems.map((item) => plannedSnapshotStep(redactString(item, secrets)));
  }
  return result;
}

export function createAllureEmitter(options: AllureEmitterOptions): AllureEmitter {
  const projectName = resolveProjectName(options.rootDir);
  const writer = createAtomicWriter(options.resultsDir);
  const environmentInfo: EnvironmentInfo = {
    environment: options.environment,
    // `target_version` is a run-level value: unlike record.json/
    // step record.json, nothing has redacted it yet.
    ...(options.targetVersion !== undefined
      ? { target_version: redactString(options.targetVersion, options.secrets) }
      : {}),
  };
  const categories: Category[] = buildCategories();
  const runtime = new ReporterRuntime({ writer, categories, environmentInfo });

  // The state this module carries across `beginScenario`/`emitStep`/
  // `endScenario`, safe only because the process holding this one instance
  // runs one scenario at a time (this file's own header). All six are
  // reset both before the first `beginScenario` and once `endScenario` has
  // cleared them, so a
  // stray `emitStep` call outside a scenario's own begin/end pair is a
  // no-op rather than attaching to the *previous* scenario's own scope or
  // buffer. `progressAnchorMs`/`progressCeilingMs`/`progressUuid` are
  // `null` exactly when there is no open scope to write a snapshot under
  // (mirrors `currentScopeUuid` itself). `progressUuid` is assigned once
  // `beginScenario` opens its scope, and every progress snapshot that
  // scenario writes reuses it (this file's own header explains why one
  // uuid has to serve a whole scenario). `progressSnapshotCount` counts how
  // many snapshots this scenario has written so far: it is the `start`
  // offset `writeProgressSnapshot` computes below, the sequence number that
  // tells two same-uuid snapshots apart on disk (writer.ts's own `sequence`
  // parameter), and what `endScenario` needs to know how many files to
  // delete.
  let currentScopeUuid: string | null = null;
  let bufferedSteps: MappedGwtStepOutcome[] = [];
  let progressAnchorMs: number | null = null;
  let progressCeilingMs: number | null = null;
  let progressUuid: string | null = null;
  let progressSnapshotCount = 0;

  function toAbsolute(relativePath: string): string {
    return path.join(options.rootDir, relativePath);
  }

  function writeMappedAttachment(rootUuid: string, parentStepUuid: string | null, attachment: MappedAttachment): void {
    if (attachment.kind === "path") {
      runtime.writeAttachment(rootUuid, parentStepUuid, attachment.name, toAbsolute(attachment.path), {
        contentType: attachment.contentType,
        wrapInStep: false,
      });
    } else {
      runtime.writeAttachment(rootUuid, parentStepUuid, attachment.name, Buffer.from(attachment.content, "utf8"), {
        contentType: attachment.contentType,
        fileExtension: attachment.fileExtension,
        wrapInStep: false,
      });
    }
  }

  /** Renders one nested child-step tree (a declared log line, a
   * sections/polls/actions timeline entry, or a call) under `parentStepUuid`
   * — never a `steps[]` entry itself, which `writeGwtSteps` below renders
   * (a `MappedChildStep` carries no attachments/message of its own, unlike
   * a `MappedGwtStep`, which is the whole reason the two need separate
   * writer functions). */
  function writeChildSteps(
    rootUuid: string,
    childSteps: readonly MappedChildStep[],
    parentStepUuid: string | null,
  ): void {
    for (const child of childSteps) {
      const uuid = runtime.startStep(rootUuid, parentStepUuid, { name: child.name, start: child.startMs });
      if (uuid !== undefined) {
        runtime.updateStep(uuid, (s) => {
          s.status = allureStatus(child.status);
          if (child.parameters && child.parameters.length > 0) {
            s.parameters = [...s.parameters, ...child.parameters];
          }
        });
        if (child.childSteps && child.childSteps.length > 0) {
          writeChildSteps(rootUuid, child.childSteps, uuid);
        }
        runtime.stopStep(uuid, { stop: child.stopMs });
      }
    }
  }

  /** Renders every one of this result's own `steps[]` entries — one
   * `startStep`/`updateStep`/`stopStep` per Given/When/Then/And, each
   * nesting its own attachments and its own child-step tree
   * (`writeChildSteps`, above) exactly the way a step's own test used to
   * before step = test and scenario = test merged back into one. */
  function writeGwtSteps(rootUuid: string, steps: readonly MappedGwtStep[]): void {
    for (const step of steps) {
      const stepUuid = runtime.startStep(rootUuid, null, { name: step.name, start: step.startMs });
      if (stepUuid === undefined) {
        continue;
      }
      runtime.updateStep(stepUuid, (s) => {
        s.status = allureStatus(step.status);
        if (step.parameters.length > 0) {
          s.parameters = [...s.parameters, ...step.parameters];
        }
        if (step.message !== undefined) {
          s.statusDetails = { message: step.message };
        }
      });
      for (const attachment of step.attachments) {
        writeMappedAttachment(rootUuid, stepUuid, attachment);
      }
      writeChildSteps(rootUuid, step.childSteps, stepUuid);
      runtime.stopStep(stepUuid, { stop: step.stopMs });
    }
  }

  function writeMappedScenarioTest(
    scopeUuid: string,
    fullName: string,
    titlePath: readonly string[],
    mapped: MappedScenarioTest,
  ): void {
    const environmentLabels = getEnvironmentLabels().map((label) => ({
      name: label.name,
      value: redactString(label.value, options.secrets),
    }));

    const partialTest: Partial<TestResult> = {
      name: mapped.name,
      fullName,
      titlePath: [...titlePath],
      status: allureStatus(mapped.status),
      description: mapped.description,
      start: mapped.startMs,
      labels: [
        getLanguageLabel(),
        getFrameworkLabel("nukadoko"),
        getHostLabel(),
        getThreadLabel(),
        ...mapped.labels,
        ...environmentLabels,
      ],
      links: mapped.links,
      parameters: mapped.parameters,
      // Allure 2's own categories matching reads `error.message`/
      // `statusDetails.message` at the *test* level — map-scenario.ts's own
      // `firstFailure` is what feeds this. `trace` carries the same
      // failure's own raw, unmarked text (map-scenario.ts's own
      // `MappedGwtStepOutcome.failure` header) — a detail pane distinct
      // from `message`'s marked summary, never a replacement for it.
      ...(mapped.message !== undefined
        ? { statusDetails: { message: mapped.message, ...(mapped.trace !== undefined ? { trace: mapped.trace } : {}) } }
        : {}),
      // `testCaseId`/`historyId` are deliberately left unset here: the SDK's
      // own `stopTest` fills both in from `fullName` (plus every
      // non-excluded parameter) the moment it runs, below — no reason to
      // reimplement that formula here (map-scenario.ts's own header).
    };

    const testUuid = runtime.startTest(partialTest, [scopeUuid]);

    for (const attachment of mapped.attachments) {
      writeMappedAttachment(testUuid, null, attachment);
    }
    writeGwtSteps(testUuid, mapped.steps);

    runtime.stopTest(testUuid, { stop: mapped.stopMs });
    runtime.writeTest(testUuid);
  }

  /** Builds and writes one progress snapshot straight through `writer`,
   * bypassing `ReporterRuntime` entirely — `startTest`/`stopTest`/
   * `writeTest` all mutate that runtime's own internal bookkeeping (its own
   * scope/test state, this file's own header), which a result that
   * `ReporterRuntime` never itself started or means to keep tracking must
   * never touch. `createTestResult`/`createStepResult` (allure-js-commons'
   * own factory functions, the same ones `ReporterRuntime.startTest`/
   * `startStep` call internally) are what give this snapshot the exact
   * same `statusDetails: {}, stage: "pending"` shape a real, still-running
   * result already has at this same point in its own lifecycle. */
  function writeProgressSnapshot(
    pickle: Pickle,
    gherkinDocument: GherkinDocument,
    relativeFeaturePath: string,
    // Set only by `emitStepProgress` (below), for the one pickle step a
    // heartbeat tick caught still running. `undefined` for every call
    // `beginScenario`/`emitStep` themselves make, which have no running step
    // to report at all (a step either hasn't started, in which case
    // `plannedSnapshotStep` already covers it below, or has already
    // finished, in which case `bufferedSteps` already covers it).
    running?: { readonly index: number; readonly startedAtMs: number; readonly liveItems: readonly string[] },
  ): void {
    // Captured into locals so a null check on any of the three narrows all
    // of them for the rest of this call, the same pattern `emitStep`'s own
    // `scopeUuid` local uses below for `currentScopeUuid`.
    const anchor = progressAnchorMs;
    const ceiling = progressCeilingMs;
    const uuid = progressUuid;
    if (anchor === null || ceiling === null || uuid === null) {
      return;
    }
    const posixPath = toPosixPath(relativeFeaturePath);
    const featureName = gherkinDocument.feature?.name ?? "";

    const result = createTestResult(uuid);
    result.name = pickle.name;
    result.fullName = buildFullName(projectName, posixPath, pickle.name);
    result.titlePath = buildTitlePath(projectName, posixPath, featureName);
    // `progressSnapshotCount` is this scenario's own snapshot count so far
    // (this function's own `writer.writeProgressSnapshot` call below is
    // what advances it, after this line runs), so this strictly increases
    // by one on every call: `beginScenario`'s own first call gets
    // `anchor + 0`, the next gets `anchor + 1`, and so on, whether that call
    // came from `beginScenario`, `emitStep`, or a heartbeat tick's own
    // `emitStepProgress`: every one of them funnels through this same
    // function and this same counter. The `Math.min` against `ceiling` is a
    // defensive clamp: `anchor` already budgets for every write a scenario
    // could make, heartbeats included (`beginScenario`'s own comment on
    // `progressAnchorMs`), so a run that stays inside that budget never
    // reaches `ceiling` at all. If something calls this more times than the
    // budget allows anyway, the clamp stops `start` from ever reaching or
    // passing the real result's own `start`, which is `ceiling + 1`.
    // `sequence` is the same number this scenario's own file-name scheme
    // needs to tell same-uuid snapshots apart (writer.ts's own `sequence`
    // parameter): one number plays both roles at once.
    const sequence = progressSnapshotCount;
    result.start = Math.min(anchor + sequence, ceiling);
    // Identity only (req 2's own invariant) — `mapScenario`'s own context
    // parameters (environment/session/target_version) are excluded from
    // historyId already, so a snapshot that never carries them changes
    // nothing a reader could compare against the real result.
    result.parameters = [
      ...buildExampleParameters(gherkinDocument, pickle),
      { name: "nukadoko.scenario.steps", value: buildScenarioStepsSignature(pickle), mode: "hidden" },
    ];
    // The exact same allure-js-commons helpers `ReporterRuntime.stopTest`
    // itself calls for the real result (map-scenario.ts's own header) —
    // called explicitly here because a snapshot never reaches `stopTest`
    // at all (this function's own doc comment).
    result.testCaseId = getTestResultTestCaseId(result);
    result.historyId = getTestResultHistoryId(result);

    result.steps = pickle.steps.map((pickleStep, index) => {
      const outcome = bufferedSteps[index];
      if (outcome !== undefined) {
        return mappedGwtStepToSnapshotStep(outcome.step);
      }
      const name = buildStepName(gherkinDocument, pickle, index, pickleStep.text);
      return running !== undefined && running.index === index
        ? runningSnapshotStep(name, running.startedAtMs, Date.now(), running.liveItems, options.secrets)
        : plannedSnapshotStep(name);
    });

    // `hooks: []` — a hook's own outcome is never known mid-scenario, only
    // once `endScenario` maps `record.hooks` (this file's own header).
    const classifiedFailure = firstFailure(bufferedSteps, []);
    if (classifiedFailure !== undefined) {
      result.statusDetails = { message: classifiedFailure.message, trace: classifiedFailure.rawMessage };
    }

    writer.writeProgressSnapshot(result, sequence);
    progressSnapshotCount = sequence + 1;
  }

  function emitFixture(scopeUuid: string, hook: MappedHook, declaredParameters: readonly MappedParameter[]): void {
    const fixtureUuid = runtime.startFixture(scopeUuid, hook.type, { name: hook.name, start: hook.startMs });
    if (fixtureUuid === undefined) {
      return;
    }
    runtime.updateFixture(fixtureUuid, (f) => {
      f.status = allureStatus(hook.status);
      if (hook.message !== undefined) {
        f.statusDetails = { message: hook.message };
      }
      if (declaredParameters.length > 0) {
        f.parameters = [...f.parameters, ...declaredParameters];
      }
    });
    for (const attachment of hook.attachments) {
      writeMappedAttachment(fixtureUuid, null, attachment);
    }
    writeChildSteps(fixtureUuid, hook.childSteps, null);
    runtime.stopFixture(fixtureUuid, { stop: hook.stopMs });
  }

  return {
    begin(): void {
      // Measurement must never break execution — the same principle every
      // method below already follows.
      try {
        runtime.writeCategoriesDefinitions();
        runtime.writeEnvironmentInfo();
        // Crash-abandoned progress files from a previous run — this run's
        // own `beginScenario` calls are what will write fresh ones (this
        // file's own header). Never touches a real `*-result.json`.
        writer.cleanProgressSnapshots();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(`warning: allure begin failed: ${message}\n`);
      }
    },

    beginScenario(input: BeginScenarioInput): void {
      bufferedSteps = [];
      progressSnapshotCount = 0;
      progressAnchorMs = null;
      progressCeilingMs = null;
      progressUuid = null;
      try {
        currentScopeUuid = runtime.startScope();
      } catch (error) {
        currentScopeUuid = null;
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(`warning: allure beginScenario failed: ${message}\n`);
      }
      if (currentScopeUuid === null) {
        return;
      }
      // Set once, for every progress snapshot this scenario will ever write
      // (`BeginScenarioInput.startedAt`'s own doc comment). The budget below
      // the real start reserves `heartbeatCap + 1` writes per step (one
      // step's own worst case: every heartbeat tick it can produce, plus its
      // own `emitStep`) and 2 more for `beginScenario`'s own initial write
      // plus a spare millisecond of headroom (this file's own header, the
      // paragraph on this formula). An on-budget run writes far fewer than
      // this and lands well below `progressCeilingMs`, never at it.
      const heartbeatCap = options.heartbeatCap ?? DEFAULT_HEARTBEAT_CAP;
      progressAnchorMs = input.startedAt.getTime() - (input.pickle.steps.length * (heartbeatCap + 1) + 2);
      progressCeilingMs = input.startedAt.getTime() - 1;
      // One uuid for this whole scenario, fresh from the last one (this
      // file's own header explains why a fixed uuid per scenario, rather
      // than a fixed uuid shared across scenarios, is what a detail page
      // needs).
      progressUuid = randomUuid();
      try {
        writeProgressSnapshot(input.pickle, input.gherkinDocument, input.relativeFeaturePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(`warning: allure beginScenario snapshot failed: ${message}\n`);
      }
    },

    emitStep(input: EmitStepInput): void {
      // Captured into a local so TypeScript's own narrowing survives the
      // calls below (`currentScopeUuid` is an outer `let`, reassigned by
      // `beginScenario`/`endScenario`, so a bare null check on it doesn't
      // narrow across a function call the way a local `const` does).
      const scopeUuid = currentScopeUuid;
      if (scopeUuid === null) {
        // `beginScenario` never ran or itself failed — nothing to buffer
        // this step's own entry under. Already warned there; silent here so
        // one failed scenario doesn't repeat the same warning once per
        // step.
        return;
      }
      try {
        const outcome = mapGwtStep({
          index: input.index,
          record: input.record,
          stepRecord: input.stepRecord,
          finishedAt: input.finishedAt,
          gherkinDocument: input.gherkinDocument,
          pickle: input.pickle,
        });
        bufferedSteps.push(outcome);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(
          `warning: allure emitStep failed for scenario ${input.scenarioId} step ${input.index}: ${message}\n`,
        );
        // A minimal fallback entry, not a skipped one: every element of
        // `record.steps` needs exactly one `steps[]` entry, in order, or
        // every later step's own position silently shifts, misaligning the
        // report against the feature file that named them.
        const t = input.finishedAt.getTime();
        bufferedSteps.push({
          step: {
            name: input.record.text,
            status: "broken",
            message,
            startMs: t,
            stopMs: t,
            attachments: [],
            parameters: [],
            childSteps: [],
          },
          declaredLabels: [],
          declaredLinks: [],
        });
      }
      try {
        writeProgressSnapshot(input.pickle, input.gherkinDocument, input.relativeFeaturePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(
          `warning: allure progress snapshot failed for scenario ${input.scenarioId} step ${input.index}: ${message}\n`,
        );
      }
    },

    emitStepProgress(input: EmitStepProgressInput): void {
      // Same "nothing open, nothing to do" no-op as `emitStep` above.
      if (currentScopeUuid === null) {
        return;
      }
      // The step at `input.index` already has its own real outcome
      // buffered. See this method's own doc comment on `AllureEmitter` for
      // why this is a defensive check, not an expected path.
      if (bufferedSteps[input.index] !== undefined) {
        return;
      }
      try {
        writeProgressSnapshot(input.pickle, input.gherkinDocument, input.relativeFeaturePath, {
          index: input.index,
          startedAtMs: input.startedAt.getTime(),
          liveItems: input.liveItems,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.stderr.write(
          `warning: allure progress heartbeat failed for scenario ${input.scenarioId} step ${input.index}: ${message}\n`,
        );
      }
    },

    endScenario(input: EndScenarioInput): void {
      const scopeUuid = currentScopeUuid;
      currentScopeUuid = null;
      const steps = bufferedSteps;
      bufferedSteps = [];
      const progressUuidToClean = progressUuid;
      const progressSnapshotCountToClean = progressSnapshotCount;
      progressUuid = null;
      progressSnapshotCount = 0;
      progressAnchorMs = null;
      progressCeilingMs = null;

      if (scopeUuid !== null) {
        try {
          const { record, gherkinDocument, pickle, relativeFeaturePath } = input;
          const posixPath = toPosixPath(relativeFeaturePath);

          const mapped = mapScenario({ record, gherkinDocument, pickle, posixPath, projectName, steps });

          // Bare `pickle.name`: a scenario's own test has nothing to
          // disambiguate itself from within its own fullName the way a
          // step's own test used to disambiguate itself from its siblings
          // (identity.ts's own header).
          const fullName = buildFullName(projectName, posixPath, pickle.name);
          const titlePath = buildTitlePath(projectName, posixPath, mapped.featureName);

          writeMappedScenarioTest(scopeUuid, fullName, titlePath, mapped);

          const scenarioStartMs = Date.parse(record.started_at);
          const scenarioStopMs = Date.parse(record.finished_at);
          for (const entry of mapHooks(record, scenarioStartMs, scenarioStopMs)) {
            emitFixture(scopeUuid, entry.hook, entry.declaredParameters);
          }

          // Attachments before the container, always: every `writeAttachment`
          // call above (the test's own, and every fixture's own) and the
          // `writeTest` call already landed synchronously, so `writeScope`
          // below is the only thing left to write.
          runtime.writeScope(scopeUuid);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          options.stderr.write(
            `warning: allure endScenario failed for scenario ${input.record.scenario_record_id}: ${message}\n`,
          );
        }
      }

      // Runs regardless of whether the real result above wrote
      // successfully (or was ever started at all): every progress snapshot
      // this scenario wrote is stale the moment `endScenario` is called,
      // real result or not, since nothing will ever `emitStep` into this
      // scenario's own buffer again. Isolated in its own try/catch per
      // sequence number so one file this writer somehow can't remove never
      // masks (or is masked by) the real result's own success/failure
      // above. `progressUuidToClean` is null exactly when
      // `progressSnapshotCountToClean` is zero (`writeProgressSnapshot`
      // only ever advances the count after a successful write under a
      // non-null uuid), so the loop below never needs a uuid it doesn't
      // have.
      if (progressUuidToClean !== null) {
        for (let sequence = 0; sequence < progressSnapshotCountToClean; sequence++) {
          try {
            writer.deleteProgressSnapshot(progressUuidToClean, sequence);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            options.stderr.write(
              `warning: allure progress cleanup failed for scenario ${input.record.scenario_record_id}: ${message}\n`,
            );
          }
        }
      }
    },
  };
}
