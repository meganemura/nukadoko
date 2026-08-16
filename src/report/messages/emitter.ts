import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export interface MessagesEmitterOptions {
  /** Absolute path. NDJSON output file. */
  readonly output: string;
  readonly rootDir: string;
  readonly stderr: WritableSink;
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
   * Truncates `output`. */
  begin(input: MessagesBeginInput): void;
  /** One scenario. Never throws. */
  emitScenario(input: MessagesEmitScenarioInput): void;
  /** Once, at the end of a run. `success` is the run's own exit code, not
   * this emitter's own health. Never
   * throws. */
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
    appendFileSync(options.output, `${JSON.stringify(envelope)}\n`);
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
        mkdirSync(path.dirname(options.output), { recursive: true });
        writeFileSync(options.output, "");
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
      } catch (error) {
        warn(`messages end failed: ${errorMessage(error)}`);
      }
    },
  };
}
