import { appendFileSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AttachmentContentEncoding,
  IdGenerator,
  SourceMediaType,
  TimeConversion,
  version as protocolVersion,
  type Envelope,
  type GherkinDocument,
  type Meta,
  type Pickle,
} from "@cucumber/messages";
import type { WritableSink } from "../../cli/writable-sink.js";
import type { ScenarioRecord } from "../../run/record-types.js";
import { readOwnVersion } from "../../version.js";
import { readStepRecordsForScenario } from "../step-records.js";
import { mapScenario, type MessagesAttachmentPlan } from "./map-scenario.js";

// Responsibility: the I/O half of this emitter — the only module in
// src/report/messages/** that touches `node:fs`:
// NDJSON writes, id generation (the one `IdGenerator.uuid()` instance this
// run's every id comes from, threaded into map-scenario.ts's pure
// `mapScenario` as its `newId` argument), and reading each declared file
// attachment's own bytes to base64-encode. map-scenario.ts stays free of
// all of that (its own header explains why); this file is the layer that
// turns its plain-data return value into an actual on-disk stream, the same
// division src/report/allure/emitter.ts already draws against its own
// map-scenario.ts sibling.
//
// Why this emitter exists at all: unlike the Allure emitter (nukadoko's own
// measurement surface), this one
// is compat-fidelity only — a migrated team's existing formatter/JUnit
// CI/HTML report keeps working. step record internals (validated result,
// observed, mutates, error.kind) never appear here: `TestStepResult`/
// `TestStepFinished` are `additionalProperties: false` closed schemas with
// no place to put them, and nothing here smuggles them in via
// a prefix or marker the way the Allure side's `[nukadoko.failure=<kind>]`
// does. This stream stays exactly what cucumber-messages defines.
//
// Failure isolation: all three public
// methods are wrapped in try/catch and never throw. `begin()`'s own failure
// (including a failed truncate) latches `enabled` false for the rest of
// this emitter's lifetime — appending onto a stream that was never
// successfully truncated would mix this run's envelopes with a previous
// run's leftover ones, a worse outcome than simply staying silent.
//
// One real file per invocation, one copy at the configured path: every
// write in this file (the truncate in `begin()`, every `appendFileSync` in
// `appendEnvelope`) targets `runOutput` — `options.output` with its own
// run id spliced into the name (`messagesRunOutputPath`, below), never
// `options.output` itself. Two `nuka run` invocations against the same
// project used to share one file, truncated at each one's own `begin()`;
// whichever began second wiped out the first's own `testRunStarted`
// without removing anything the first had already appended, so both runs'
// own `testRunFinished` still landed in one file — a combination no single
// run can ever produce. Giving each invocation its own file removes the
// shared mutable state entirely. `options.output` is only ever touched
// once, in `end()`, and only after this run's own `testRunFinished` has
// already been appended to `runOutput` — a full, atomic copy (temp file in
// the same directory, then rename, `copyOutputAtomic` below) of that now-
// complete file, so a reader of `options.output` never observes a
// half-written run and always sees either the previous run's complete
// stream or this one's, never a mix of the two. `runOutput` itself is left
// on disk afterward — cleanup is `nuka clean`'s job (src/cli/clean.ts),
// the same way it already owns cleanup for every other accumulated
// artifact this tool writes.

export interface MessagesEmitterOptions {
  /** Absolute path. The stable NDJSON location a project's own tooling
   * points at — this emitter's real writes land in a sibling file instead
   * (see this file's own header); `output` itself is only ever replaced,
   * atomically, once this run's own stream is complete. */
  readonly output: string;
  readonly rootDir: string;
  readonly stderr: WritableSink;
  /** This invocation's own run id (src/run/run-id.ts) — spliced into
   * `output`'s own name to build the file this emitter actually writes to
   * (`messagesRunOutputPath`, below). */
  readonly runId: string;
}

/** The file this emitter actually writes to for one invocation: `output`
 * with its own basename (extension stripped) followed by `.<runId>.ndjson`,
 * beside `output` itself. Always a literal `.ndjson` extension, regardless
 * of `output`'s own — the name only needs to be unique and self-describing,
 * not to mirror a user-chosen extension. Exported so `nuka clean`
 * (src/cli/clean.ts) can build the same name without re-deriving this
 * rule. */
export function messagesRunOutputPath(output: string, runId: string): string {
  const base = path.basename(output, path.extname(output));
  return path.join(path.dirname(output), `${base}.${runId}.ndjson`);
}

/** True for any file this emitter's own naming produces beside `output`
 * for *some* run id, never for `output` itself. `output` can be relocated
 * to a user-owned directory (`messages.output` in `nukadoko.config.ts`),
 * so this only matches on the one part of a run id's own format
 * (src/run/run-id.ts) that is safe to depend on here, its `run-` prefix —
 * matching any `<base>.<anything>.ndjson` instead would let `nuka clean`
 * delete an unrelated file a project happens to keep beside its own
 * configured path (e.g. a hand-kept `messages.backup.ndjson`). */
export function isMessagesRunOutputFileName(output: string, candidateFileName: string): boolean {
  if (candidateFileName === path.basename(output)) {
    return false;
  }
  const base = path.basename(output, path.extname(output));
  return candidateFileName.startsWith(`${base}.run-`) && candidateFileName.endsWith(".ndjson");
}

/** One feature file's own contribution to `begin()` (a directory-target
 * `nuka run` folds N feature files into this
 * one run's own single messages stream, so `begin()` needs one of these per
 * file rather than exactly one). */
export interface MessagesBeginFeatureInput {
  readonly relativeFeaturePath: string;
  readonly gherkinDocument: GherkinDocument;
  readonly pickles: readonly Pickle[];
}

export interface MessagesBeginInput {
  /** In the exact order `begin()` should write them — cli/run.ts already
   * hands this the same deterministic, byte-order-sorted order its own
   * pickle loop runs in, so
   * this emitter has no ordering decision of its own to make. */
  readonly features: readonly MessagesBeginFeatureInput[];
}

export interface MessagesEmitScenarioInput {
  readonly record: ScenarioRecord;
  readonly pickle: Pickle;
}

export interface MessagesEmitter {
  /** Once, at the start of a run. Writes `meta`, then, per feature in
   * `input.features`'s own order, that feature's `source` /
   * `gherkinDocument` / one `pickle` per selected pickle, then one
   * `testRunStarted` once every feature has been written.
   * Truncates this invocation's own run file, never `output` itself (see
   * this file's own header). */
  begin(input: MessagesBeginInput): void;
  /** One scenario. Never throws. */
  emitScenario(input: MessagesEmitScenarioInput): void;
  /** Once, at the end of a run. `success` is the run's own exit code, not
   * this emitter's own health. Publishes this run's own complete file onto
   * `output`, atomically, as its last action (this file's own header).
   * Never throws. */
  end(success: boolean): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Normalizes a root-relative filesystem path to the POSIX separators
 * cucumber-messages `uri` fields use, regardless of which separator the
 * host OS's own `path` produced — a small, deliberate duplicate of
 * src/report/allure/identity.ts's own `toPosixPath`: importing from
 * the allure/ directory would make this emitter — meant to be that
 * directory's sibling, not its dependent — reach sideways into it. */
function toPosixPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

/** Writes `sourcePath`'s current bytes to `finalPath`, atomically: a temp
 * file in `finalPath`'s own directory (never a different filesystem/mount,
 * which is what makes the rename itself atomic), written in full, then
 * renamed onto `finalPath` — mirrors src/report/allure/writer.ts's own
 * `copyAtomic`, a small, deliberate duplicate for the same "stay this
 * directory's sibling, not its dependent" reason `toPosixPath` above
 * already gives. */
function copyOutputAtomic(finalPath: string, sourcePath: string): void {
  const tempName = `.${path.basename(finalPath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tempPath = path.join(path.dirname(finalPath), tempName);
  copyFileSync(sourcePath, tempPath);
  renameSync(tempPath, finalPath);
}

function buildMeta(): Meta {
  return {
    protocolVersion,
    // `version` on `implementation`: read via
    // src/version.ts's readOwnVersion(), which throws if nukadoko's own
    // package.json can't be found or has no string `version` — a packaging
    // bug, not something to guess a fallback for here. Deliberately not
    // caught locally: buildMeta() is only ever called from begin() (below),
    // which already wraps its whole body in try/catch (this file's own
    // header, "Failure isolation") and treats any failure there — this one
    // included — as "messages begin failed", latching `enabled` false for
    // the rest of the run. `Product.version` staying optional in the
    // cucumber-messages schema is unrelated to that failure path; it exists
    // for implementations that never had a version to report, not as a
    // shrug for one that failed to read its own.
    implementation: { name: "nukadoko", version: readOwnVersion() },
    runtime: { name: "node", version: process.versions.node },
    os: { name: process.platform },
    cpu: { name: process.arch },
    // `ci` omitted: detecting it needs a
    // separate package, which nukadoko doesn't add a dependency on for this.
  };
}

export function createMessagesEmitter(options: MessagesEmitterOptions): MessagesEmitter {
  const newId = IdGenerator.uuid();
  // This invocation's own real file — every write below targets this, never
  // `options.output` (this file's own header, "One real file per
  // invocation, one copy at the configured path").
  const runOutput = messagesRunOutputPath(options.output, options.runId);
  let enabled = false;
  // `afterStep` — keyed by
  // `step_index`, mirroring `before`/`after` but one id per index rather
  // than one for the whole run (map-scenario.ts's own `MapScenarioInput.
  // hookIds` header explains why).
  let hookIds: { before?: string; after?: string; afterStep?: Record<number, string> } = {};

  function warn(message: string): void {
    options.stderr.write(`warning: ${message}\n`);
  }

  function appendEnvelope(envelope: Envelope): void {
    appendFileSync(runOutput, `${JSON.stringify(envelope)}\n`);
  }

  // A declared file attachment's bytes are read and base64-encoded here
  // (always BASE64-encode, even for text,
  // since either encoding is equally lossless, so no branch is worth
  // adding) — a `"built"` plan (a declared log line) is
  // already a complete `Attachment`, map-scenario.ts's own job, not this
  // one's. A file that can't be read is dropped with a warning; the
  // scenario's own stream continues (drop
  // just that one attachment and warn).
  function writeAttachment(plan: MessagesAttachmentPlan): void {
    if (plan.kind === "built") {
      appendEnvelope({ attachment: plan.attachment });
      return;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(path.join(options.rootDir, plan.relativePath));
    } catch (error) {
      warn(`could not read attachment ${plan.relativePath}: ${errorMessage(error)}`);
      return;
    }
    appendEnvelope({
      attachment: {
        body: bytes.toString("base64"),
        contentEncoding: AttachmentContentEncoding.BASE64,
        mediaType: plan.mediaType,
        fileName: plan.fileName,
        testCaseStartedId: plan.testCaseStartedId,
        testStepId: plan.testStepId,
      },
    });
  }

  return {
    begin(input: MessagesBeginInput): void {
      try {
        // Truncates `runOutput`, this invocation's own file — never
        // `options.output`, which stays whatever the last completed run
        // left it as until `end()` below replaces it in one atomic step
        // (this file's own header).
        mkdirSync(path.dirname(runOutput), { recursive: true });
        writeFileSync(runOutput, "");
        enabled = true;

        appendEnvelope({ meta: buildMeta() });

        // One (`source`, `gherkinDocument`, `pickle`*N) group per feature,
        // in `input.features`'s own order (a directory target folds N
        // files into this one stream) — every
        // envelope inside one file's own group still uses that one file's
        // own uri, never a later or earlier file's, so a reader joining
        // `source`/`gherkinDocument`/`pickle` by uri can never cross two
        // different files by accident.
        for (const featureInput of input.features) {
          // `source.uri` is made identical to `pickle.uri`/`gherkinDocument.
          // uri` by construction (a consumer
          // joins the three of them together via this one uri) —
          // `gherkinDocument.uri` first
          // (@cucumber/gherkin's own `Parser.parse` never sets it in this
          // repo's usage today, so this is a forward-compatible first
          // choice), falling back to the posix'd relative feature path
          // otherwise, then stamped onto every one of the three envelopes
          // below rather than trusted to already agree.
          const uri = featureInput.gherkinDocument.uri ?? toPosixPath(featureInput.relativeFeaturePath);

          try {
            const data = readFileSync(path.join(options.rootDir, featureInput.relativeFeaturePath), "utf8");
            appendEnvelope({ source: { uri, data, mediaType: SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN } });
          } catch (error) {
            // Feature source unreadable: drop only this feature's own
            // `source` envelope, not the rest of `begin()` — warn and drop
            // only the source envelope; everything else continues,
            // including every other feature in this loop.
            warn(`could not read feature source for messages: ${errorMessage(error)}`);
          }

          appendEnvelope({ gherkinDocument: { ...featureInput.gherkinDocument, uri } });
          for (const pickle of featureInput.pickles) {
            appendEnvelope({ pickle: { ...pickle, uri } });
          }
        }

        appendEnvelope({ testRunStarted: { timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(Date.now()) } });
      } catch (error) {
        // Includes a failed truncate itself (this file's own header) —
        // latches `enabled` false so emitScenario/end go silently inert
        // rather than appending onto an unknown, possibly stale file.
        enabled = false;
        warn(`messages begin failed: ${errorMessage(error)}`);
      }
    },

    emitScenario(input: MessagesEmitScenarioInput): void {
      if (!enabled) {
        return;
      }
      try {
        const stepRecords = readStepRecordsForScenario(options.rootDir, input.record);
        const mapped = mapScenario({
          record: input.record,
          stepRecords,
          pickle: input.pickle,
          newId,
          hookIds,
        });

        for (const entry of mapped.newHooks) {
          appendEnvelope({ hook: entry.hook });
          if (entry.type === "after_step") {
            hookIds = { ...hookIds, afterStep: { ...hookIds.afterStep, [entry.stepIndex]: entry.hook.id } };
          } else {
            hookIds = { ...hookIds, [entry.type]: entry.hook.id };
          }
        }

        appendEnvelope({ testCase: mapped.testCase });
        appendEnvelope({ testCaseStarted: mapped.testCaseStarted });

        for (const step of mapped.steps) {
          appendEnvelope({ testStepStarted: step.testStepStarted });
          for (const attachment of step.attachments) {
            writeAttachment(attachment);
          }
          appendEnvelope({ testStepFinished: step.testStepFinished });
        }

        appendEnvelope({ testCaseFinished: mapped.testCaseFinished });
      } catch (error) {
        warn(`messages emit failed for scenario ${input.record.scenario_record_id}: ${errorMessage(error)}`);
      }
    },

    end(success: boolean): void {
      if (!enabled) {
        return;
      }
      try {
        appendEnvelope({
          testRunFinished: { success, timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(Date.now()) },
        });
        // `runOutput` is now this run's own complete stream — replace
        // `options.output` with it in one atomic step (this file's own
        // header). Left inside the same try/catch as the append above:
        // either both succeed, or this run's failure to publish is
        // reported the same way its failure to finish would be, never
        // silently.
        copyOutputAtomic(options.output, runOutput);
      } catch (error) {
        warn(`messages end failed: ${errorMessage(error)}`);
      }
    },
  };
}
