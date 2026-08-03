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
import { readReceiptsForRecord } from "../receipts.js";
import { mapScenario, type MessagesAttachmentPlan } from "./map-scenario.js";

// Responsibility: the I/O half of this emitter (this task's spec, decision
// 1) — the only module in src/report/messages/** that touches `node:fs`:
// NDJSON writes, id generation (the one `IdGenerator.uuid()` instance this
// run's every id comes from, threaded into map-scenario.ts's pure
// `mapScenario` as its `newId` argument), and reading each declared file
// attachment's own bytes to base64-encode. map-scenario.ts stays free of
// all of that (its own header explains why); this file is the layer that
// turns its plain-data return value into an actual on-disk stream, the same
// division src/report/allure/emitter.ts already draws against its own
// map-scenario.ts sibling.
//
// Why this emitter exists at all (this task's spec's own "this emitter's
// role" section):
// unlike the Allure emitter (nukadoko's own measurement surface), this one
// is compat-fidelity only — a migrated team's existing formatter/JUnit
// CI/HTML report keeps working. receipt internals (validated result,
// observed, mutates, error.kind) never appear here: `TestStepResult`/
// `TestStepFinished` are `additionalProperties: false` closed schemas with
// no place to put them, and this task's spec forbids smuggling them in via
// a prefix or marker the way the Allure side's `[nukadoko.failure=<kind>]`
// does.
//
// Failure isolation (this task's spec, decision 3): all three public
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

export interface MessagesBeginInput {
  readonly relativeFeaturePath: string;
  readonly gherkinDocument: GherkinDocument;
  readonly pickles: readonly Pickle[];
}

export interface MessagesEmitScenarioInput {
  readonly record: ScenarioRecord;
  readonly pickle: Pickle;
}

export interface MessagesEmitter {
  /** Once, at the start of a run. Writes `meta` / `source` /
   * `gherkinDocument` / one `pickle` per selected pickle / `testRunStarted`,
   * in that order (this task's spec, decision 4). Truncates `output`. */
  begin(input: MessagesBeginInput): void;
  /** One scenario. Never throws (this task's spec, decision 3). */
  emitScenario(input: MessagesEmitScenarioInput): void;
  /** Once, at the end of a run. `success` is the run's own exit code, not
   * this emitter's own health (this task's spec, decision 8). Never
   * throws. */
  end(success: boolean): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Normalizes a root-relative filesystem path to the POSIX separators
 * cucumber-messages `uri` fields use, regardless of which separator the
 * host OS's own `path` produced — a small, deliberate duplicate of
 * src/report/allure/identity.ts's own `toPosixPath` (this task's spec lists
 * only src/report/media-type.ts and src/report/receipts.ts as shared
 * extractions; this one-line helper wasn't one of them, and importing from
 * the allure/ directory would make this emitter — meant to be that
 * directory's sibling, not its dependent — reach sideways into it). */
function toPosixPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function buildMeta(): Meta {
  return {
    protocolVersion,
    // `version` on `implementation` (own-version task spec): read via
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
    // `ci` omitted (this task's spec, decision 5): detecting it needs a
    // separate package this task does not add.
  };
}

export function createMessagesEmitter(options: MessagesEmitterOptions): MessagesEmitter {
  const newId = IdGenerator.uuid();
  let enabled = false;
  let hookIds: { before?: string; after?: string } = {};

  function warn(message: string): void {
    options.stderr.write(`warning: ${message}\n`);
  }

  function appendEnvelope(envelope: Envelope): void {
    appendFileSync(options.output, `${JSON.stringify(envelope)}\n`);
  }

  // A declared file attachment's bytes are read and base64-encoded here
  // (this task's spec, decision 9: always BASE64-encode, even for text,
  // since either encoding is equally lossless, so no branch is worth
  // adding) — a `"built"` plan (a declared log line) is
  // already a complete `Attachment`, map-scenario.ts's own job, not this
  // one's. A file that can't be read is dropped with a warning; the
  // scenario's own stream continues (this task's spec, decision 9: drop
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

        // `source.uri` is made identical to `pickle.uri`/`gherkinDocument.
        // uri` by construction (this task's spec, decision 4: a consumer
        // joins the three of them together via this one uri) —
        // `gherkinDocument.uri` first
        // (@cucumber/gherkin's own `Parser.parse` never sets it in this
        // repo's usage today, so this is a forward-compatible first
        // choice), falling back to the posix'd relative feature path
        // otherwise, then stamped onto every one of the three envelopes
        // below rather than trusted to already agree.
        const uri = input.gherkinDocument.uri ?? toPosixPath(input.relativeFeaturePath);

        try {
          const data = readFileSync(path.join(options.rootDir, input.relativeFeaturePath), "utf8");
          appendEnvelope({ source: { uri, data, mediaType: SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN } });
        } catch (error) {
          // Feature source unreadable: drop only the `source` envelope, not
          // the rest of `begin()` (this task's spec, decision 4: if it
          // can't be read, warn and drop only the source envelope —
          // everything else continues).
          warn(`could not read feature source for messages: ${errorMessage(error)}`);
        }

        appendEnvelope({ gherkinDocument: { ...input.gherkinDocument, uri } });
        for (const pickle of input.pickles) {
          appendEnvelope({ pickle: { ...pickle, uri } });
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
        const receipts = readReceiptsForRecord(options.rootDir, input.record);
        const mapped = mapScenario({ record: input.record, receipts, pickle: input.pickle, newId, hookIds });

        for (const { type, hook } of mapped.newHooks) {
          appendEnvelope({ hook });
          hookIds = { ...hookIds, [type]: hook.id };
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
        warn(`messages emit failed for scenario ${input.record.scenario_id}: ${errorMessage(error)}`);
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
