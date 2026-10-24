import {
  AttachmentContentEncoding,
  HookType,
  TestStepResultStatus,
  TimeConversion,
  type Attachment,
  type Hook,
  type Pickle,
  type PickleStep,
  type TestCase,
  type TestCaseFinished,
  type TestCaseStarted,
  type TestStep,
  type TestStepFinished,
  type TestStepStarted,
  type TestStepResult,
} from "@cucumber/messages";
import type { DeclaredSnapshot } from "../../compat/declared.js";
import type { StepRecord } from "../../record/types.js";
import type { ScenarioHookRecord, ScenarioRecord, ScenarioStepEntry, ScenarioStepStatus } from "../../record/scenario-record.js";
import { contentTypeForFileName } from "../media-type.js";
import { ownStepSpan, placeSteps } from "../step-timeline.js";

// Responsibility: the pure transform at the center of this module:
// map-scenario.ts is a pure function that
// assembles one scenario's worth of envelope material and never touches
// the filesystem — `(record, stepRecords,
// pickle, newId, hookIds) -> cucumber-messages envelope material for one
// scenario`. No `node:fs` anywhere in this file: every input is already
// resolved by the caller (src/report/messages/write-stream.ts reads record.json
// files via src/report/step-records.ts before calling this), so this module can
// be driven entirely from fixture data in a test, no real NDJSON stream and
// no real IdGenerator anywhere in the call graph — `newId` is passed in
// specifically so a test can substitute `IdGenerator.incrementing()` for
// deterministic ids.
//
// `@cucumber/messages` is fine to import here (types and the odd runtime
// value/enum alike, e.g. `TestStepResultStatus`, `HookType`,
// `AttachmentContentEncoding`) — it is plain data with no I/O of its own,
// the same allowance src/report/allure/map-scenario.ts's own header claims
// for the same package.
//
// Unlike the Allure sibling this mirrors, this module never touches
// `GherkinDocument` at all: a cucumber-messages `TestStep` carries no name
// of its own (a consumer resolves a step's text by joining
// `pickleStepId`/`hookId` back to the `pickle`/`hook` envelopes already in
// the stream), so there is nothing here for a gherkin keyword lookup to do.
//
// This module never builds a `Hook`/`TestCase`/... envelope wrapper
// (`{ hook: ... }`, `{ testCase: ... }`) itself — it returns the bare
// message bodies; src/report/messages/write-stream.ts (the only place that
// touches `node:fs`) wraps each one and decides the on-disk order.

/** A declared file attachment still needs its bytes read and base64-encoded
 * (I/O — write-stream.ts's job); a declared log line is already a complete
 * `Attachment` body (no file to read, so the always-BASE64-since-either-
 * encoding-is-lossless reasoning below doesn't apply
 * to it — IDENTITY is pinned for logs specifically) and so is built here in
 * full. Keeping
 * both cases in one discriminated union (rather than two parallel lists)
 * preserves declared.attachments-then-declared.logs order as a single
 * ordered sequence for write-stream.ts to walk. */
export type MessagesAttachmentPlan =
  | {
      readonly kind: "file";
      readonly testCaseStartedId: string;
      readonly testStepId: string;
      readonly fileName: string;
      readonly mediaType: string;
      /** Root-relative path (rootDir + this) — write-stream.ts resolves and
       * reads it. */
      readonly relativePath: string;
    }
  | { readonly kind: "built"; readonly attachment: Attachment };

/** cucumber-js's own media type for `this.log()` output — its
 * `src/runtime/attachment_manager/index.ts` defines `log(text)` as
 * `this.create(text, 'text/x.cucumber.log+plain')` (read from upstream
 * `main`). Reused here so a consumer's existing "is this a log line" check
 * (matching on this exact media type) keeps working for a nukadoko-produced
 * stream too. */
const CUCUMBER_LOG_MEDIA_TYPE = "text/x.cucumber.log+plain";

function joinRelative(dir: string, fileName: string): string {
  return `${dir.replace(/\/+$/, "")}/${fileName}`;
}

// `declared.attachments`/`declared.logs` —
// the only two `declared` sub-fields this module reads. `declared.labels`/
// `links`/`parameters` have no home in the messages protocol's closed
// schema and are dropped here (known limit, documented in docs/spec.md's
// "Honest limits" list).
function declaredAttachmentPlans(
  declared: DeclaredSnapshot | undefined,
  evidenceDir: string,
  testCaseStartedId: string,
  testStepId: string,
): MessagesAttachmentPlan[] {
  if (!declared) {
    return [];
  }
  const filePlans: MessagesAttachmentPlan[] = (declared.attachments ?? []).map((fileName) => ({
    kind: "file",
    testCaseStartedId,
    testStepId,
    fileName,
    mediaType: contentTypeForFileName(fileName),
    relativePath: joinRelative(evidenceDir, fileName),
  }));
  const logPlans: MessagesAttachmentPlan[] = (declared.logs ?? []).map((text) => ({
    kind: "built",
    attachment: {
      body: text,
      contentEncoding: AttachmentContentEncoding.IDENTITY,
      mediaType: CUCUMBER_LOG_MEDIA_TYPE,
      testCaseStartedId,
      testStepId,
    },
  }));
  return [...filePlans, ...logPlans];
}

function statusForStep(status: ScenarioStepStatus): TestStepResultStatus {
  switch (status) {
    case "passed":
      return TestStepResultStatus.PASSED;
    case "failed":
      return TestStepResultStatus.FAILED;
    case "skipped":
      return TestStepResultStatus.SKIPPED;
    case "undefined":
      return TestStepResultStatus.UNDEFINED;
    case "ambiguous":
      return TestStepResultStatus.AMBIGUOUS;
  }
}

/** The message a step carries when its step record could not be read. */
export function unreadableStepMessage(step: ScenarioStepEntry): string {
  return `step record ${step.step_record_id} could not be read; run.json records this step as ${step.status}`;
}

function statusForHook(status: "passed" | "failed"): TestStepResultStatus {
  return status === "passed" ? TestStepResultStatus.PASSED : TestStepResultStatus.FAILED;
}

// Duration never negative: a step with no step record is zero-width by
// construction (step-timeline.ts), but a real step record's own
// started_at/finished_at pair is operator-authored input this module has no
// way to fully trust.
function buildResult(
  status: TestStepResultStatus,
  message: string | undefined,
  startMs: number,
  stopMs: number,
  claimBroken = false,
): TestStepResult {
  return {
    status,
    duration: TimeConversion.millisecondsToDuration(Math.max(stopMs - startMs, 0)),
    ...(message !== undefined ? { message } : {}),
    // `exception` is set for a broken claim only: `Exception.type` is
    // required, and a broken claim is the one failure whose type is a
    // fact nukadoko decided (docs/spec.md "Claims"). Any other failure
    // carries a message alone.
    ...(claimBroken && message !== undefined ? { exception: { type: CLAIM_BROKEN_EXCEPTION, message } } : {}),
  };
}

/** `Exception.type` of a step whose claim did not hold. */
export const CLAIM_BROKEN_EXCEPTION = "nukadoko.ClaimBroken";

/** The media type of the attachment that carries a claim step's claims,
 * so a consumer can find it among the step's other attachments. */
export const CLAIMS_MEDIA_TYPE = "application/vnd.nukadoko.claims+json";

function claimsAttachment(stepRecord: StepRecord, testCaseStartedId: string, testStepId: string): MessagesAttachmentPlan[] {
  if (stepRecord.claims === undefined) return [];
  return [
    {
      kind: "built",
      attachment: {
        // The readings go with the claims: a value that walked toward the
        // expected one across a poll is visible only in them.
        body: JSON.stringify({
          claims: stepRecord.claims,
          observation: stepRecord.observation,
          attempts: stepRecord.attempts,
          ...(stepRecord.readings === undefined ? {} : { readings: stepRecord.readings }),
          ...(stepRecord.readings_left_out === undefined ? {} : { readings_left_out: stepRecord.readings_left_out }),
        }),
        contentEncoding: AttachmentContentEncoding.IDENTITY,
        mediaType: CLAIMS_MEDIA_TYPE,
        fileName: "claims.json",
        testCaseStartedId,
        testStepId,
      },
    },
  ];
}

export interface MappedTestStep {
  readonly testStep: TestStep;
  readonly testStepStarted: TestStepStarted;
  readonly testStepFinished: TestStepFinished;
  /** Emitted between `testStepStarted` and `testStepFinished` — that's
   * what cucumber's own runner does. */
  readonly attachments: readonly MessagesAttachmentPlan[];
}

function mapPickleSteps(
  record: ScenarioRecord,
  stepRecords: ReadonlyMap<string, StepRecord | null>,
  pickleSteps: readonly PickleStep[],
  scenarioStartMs: number,
  testCaseStartedId: string,
  newId: () => string,
): MappedTestStep[] {
  const resolved = record.steps.map((step) =>
    step.step_record_id !== null ? (stepRecords.get(step.step_record_id) ?? undefined) : undefined,
  );
  // A step record the run wrote and this render could not read leaves the
  // step UNKNOWN, not the status run.json gives it: a PASSED step with no
  // detail would read as a complete one.
  const unreadable = record.steps.map(
    (step) => step.step_record_id !== null && stepRecords.has(step.step_record_id) && stepRecords.get(step.step_record_id) === null,
  );
  const spans = placeSteps(scenarioStartMs, resolved.map(ownStepSpan));
  return record.steps.map((step, index): MappedTestStep => {
    const stepRecord = resolved[index];
    const { startMs, stopMs } = spans[index]!;

    const testStepId = newId();
    const pickleStepId = pickleSteps[index]?.id;
    const attachments = stepRecord
      ? [
          ...declaredAttachmentPlans(stepRecord.declared, stepRecord.evidence.dir, testCaseStartedId, testStepId),
          ...claimsAttachment(stepRecord, testCaseStartedId, testStepId),
        ]
      : [];

    return {
      testStep: {
        id: testStepId,
        // `stepDefinitionIds`/`stepMatchArgumentsLists` deliberately never
        // set — omitted keys, not `undefined`
        // ones, since `JSON.stringify` treats the two identically for NDJSON
        // output.
        ...(pickleStepId !== undefined ? { pickleStepId } : {}),
      },
      testStepStarted: {
        testCaseStartedId,
        testStepId,
        timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(startMs),
      },
      testStepFinished: {
        testCaseStartedId,
        testStepId,
        timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(stopMs),
        testStepResult: unreadable[index]
          ? buildResult(TestStepResultStatus.UNKNOWN, unreadableStepMessage(step), startMs, stopMs)
          : buildResult(
              statusForStep(step.status),
              step.error?.message,
              startMs,
              stopMs,
              stepRecord?.status === "failed" && stepRecord.error.kind === "claim_broken",
            ),
      },
      attachments,
    };
  });
}

// `hookId` is a resolver, not a single fixed string: a "before"/"after"
// call site still always
// returns the same id (one Hook definition for the whole run),
// but an "after_step" call site needs a different Hook id per `step_index`
// (see `mapScenario`'s own AfterStep section below for why: cucumber-
// messages has no field on `TestStep` to carry "which step" other than the
// `Hook.name` its `hookId` points at, so distinct step indices need
// distinct Hook envelopes to have distinct names).
function mapHookSteps(
  hooksToMap: readonly ScenarioHookRecord[],
  hookIdFor: (hook: ScenarioHookRecord) => string,
  timestampMs: number,
  evidenceDir: string,
  testCaseStartedId: string,
  newId: () => string,
): MappedTestStep[] {
  return hooksToMap.map((hook): MappedTestStep => {
    const testStepId = newId();
    const attachments = declaredAttachmentPlans(hook.declared, evidenceDir, testCaseStartedId, testStepId);
    // Before-hook = scenario start, after-hook (both "after" and
    // "after_step") = scenario finish, all zero-width (record.json carries
    // no per-hook timestamp of its own,
    // the same known limit src/report/allure/write-results.ts's own header
    // documents, and the same collapse src/report/allure/map-scenario.ts's
    // own `mapHooks` already makes for "after_step").
    return {
      testStep: { id: testStepId, hookId: hookIdFor(hook) },
      testStepStarted: {
        testCaseStartedId,
        testStepId,
        timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(timestampMs),
      },
      testStepFinished: {
        testCaseStartedId,
        testStepId,
        timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(timestampMs),
        testStepResult: buildResult(statusForHook(hook.status), hook.error?.message, timestampMs, timestampMs),
      },
      attachments,
    };
  });
}

/** A `Hook` envelope this scenario is the first to need, alongside which
 * run-wide slot it fills (created lazily, on
 * first need) — `hookIds.before`/`hookIds.after` for `"before"`/`"after"`,
 * or `hookIds.afterStep[stepIndex]` for `"after_step"` (one Hook definition
 * per distinct `step_index`, not one for the whole run, since each needs
 * its own `AfterStep[<index>]` name). */
export type NewHookEnvelope =
  | { readonly type: "before" | "after"; readonly hook: Hook }
  | { readonly type: "after_step"; readonly stepIndex: number; readonly hook: Hook };

export interface MapScenarioInput {
  readonly record: ScenarioRecord;
  /** Already-read step records, keyed by step record id — `null` for an id
   * whose
   * record.json couldn't be read/parsed. A step whose own
   * `record.steps[].step_record_id` isn't a key here at all is treated the same as
   * one mapped to `null`. */
  readonly stepRecords: ReadonlyMap<string, StepRecord | null>;
  readonly pickle: Pickle;
  readonly newId: () => string;
  /** The `Hook` id(s) already assigned earlier in this run — `undefined`/
   * absent means not yet assigned; this call
   * then allocates one via `newId` and returns it in `newHooks` for the
   * caller (write-stream.ts) to remember for every later scenario.
   * `afterStep` is keyed by `step_index` — one id per index, not one for
   * the whole run, since each
   * index gets its own `AfterStep[<index>]`-named Hook. */
  readonly hookIds: {
    readonly before?: string;
    readonly after?: string;
    readonly afterStep?: { readonly [stepIndex: number]: string };
  };
}

export interface MappedScenario {
  readonly newHooks: readonly NewHookEnvelope[];
  readonly testCase: TestCase;
  readonly testCaseStarted: TestCaseStarted;
  readonly testCaseFinished: TestCaseFinished;
  /** In envelope order: before-hook test steps, then pickle-step test steps,
   * then after_step-hook test steps, then after-hook test steps — also
   * exactly `testCase.testSteps`' own order. `after_step`
   * sits before `after`, not after it, even though both collapse to the
   * same zero-width `scenarioStopMs` instant (this file's own `mapHookSteps`
   * comment): every AfterStep hook actually finishes, in real execution,
   * before the scenario-level After hook ever starts, so this is the one
   * place that relative fact can still be preserved even though the exact
   * timestamps can't be. */
  readonly steps: readonly MappedTestStep[];
}

export function mapScenario(input: MapScenarioInput): MappedScenario {
  const { record, stepRecords, pickle, newId, hookIds } = input;
  const scenarioStartMs = Date.parse(record.started_at);
  const scenarioStopMs = Date.parse(record.finished_at);

  const beforeHooks = record.hooks.filter((hook) => hook.type === "before");
  const afterHooks = record.hooks.filter((hook) => hook.type === "after");
  const afterStepHooks = record.hooks.filter((hook) => hook.type === "after_step");

  const newHooks: NewHookEnvelope[] = [];
  let beforeHookId = hookIds.before;
  if (beforeHooks.length > 0 && beforeHookId === undefined) {
    beforeHookId = newId();
    newHooks.push({
      type: "before",
      // One Hook envelope is shared by every Before hook in the run, so a
      // stored `name` cannot be this field: it would mislabel the others.
      hook: { id: beforeHookId, name: "Before", type: HookType.BEFORE_TEST_CASE, sourceReference: {} },
    });
  }
  let afterHookId = hookIds.after;
  if (afterHooks.length > 0 && afterHookId === undefined) {
    afterHookId = newId();
    newHooks.push({
      type: "after",
      hook: { id: afterHookId, name: "After", type: HookType.AFTER_TEST_CASE, sourceReference: {} },
    });
  }

  // AfterStep: one Hook
  // definition per distinct `step_index`, created lazily and reused across
  // the run the same way before/after are (`hookIds.afterStep`, threaded in
  // by write-stream.ts) — not folded onto the existing "after" Hook id, since
  // that would give every AfterStep occurrence the same "After" name and
  // erase the one fact this preserves (which step it
  // ran after). `type: HookType.AFTER_TEST_STEP` is the protocol's own
  // existing concept for a step-level hook (messages.d.ts's `HookType`
  // enum) — using it, rather than reusing `AFTER_TEST_CASE`, is not "a new
  // concept on the cucumber-messages side"; it is the concept the protocol
  // already ships for exactly this
  // case. `Hook.name` still folds the index in (`AfterStep[<index>]`, same
  // as src/report/allure/map-scenario.ts's own `mapHooks`) because
  // `TestStep` itself has no field of its own to carry "which step" — only
  // `hookId`/`pickleStepId` (messages.d.ts's `TestStep`) — so the index has
  // nowhere to live except the Hook definition's own name. `step_index` is
  // guaranteed present on every `"after_step"` record entry
  // (src/record/scenario-record.ts: `step_index` is present only for that
  // type), hence the `!`.
  const afterStepHookIds: Record<number, string> = { ...hookIds.afterStep };
  for (const hook of afterStepHooks) {
    const stepIndex = hook.step_index!;
    if (afterStepHookIds[stepIndex] === undefined) {
      const id = newId();
      afterStepHookIds[stepIndex] = id;
      newHooks.push({
        type: "after_step",
        stepIndex,
        hook: { id, name: `AfterStep[${stepIndex}]`, type: HookType.AFTER_TEST_STEP, sourceReference: {} },
      });
    }
  }

  const testCaseId = newId();
  const testCaseStartedId = newId();

  const beforeSteps = mapHookSteps(
    beforeHooks,
    () => beforeHookId!,
    scenarioStartMs,
    record.evidence.dir,
    testCaseStartedId,
    newId,
  );
  const pickleSteps = mapPickleSteps(record, stepRecords, pickle.steps, scenarioStartMs, testCaseStartedId, newId);
  const afterStepSteps = mapHookSteps(
    afterStepHooks,
    (hook) => afterStepHookIds[hook.step_index!]!,
    scenarioStopMs,
    record.evidence.dir,
    testCaseStartedId,
    newId,
  );
  const afterSteps = mapHookSteps(afterHooks, () => afterHookId!, scenarioStopMs, record.evidence.dir, testCaseStartedId, newId);

  const steps = [...beforeSteps, ...pickleSteps, ...afterStepSteps, ...afterSteps];

  const testCase: TestCase = {
    id: testCaseId,
    pickleId: pickle.id,
    testSteps: steps.map((step) => step.testStep),
  };

  const testCaseStarted: TestCaseStarted = {
    attempt: 0,
    id: testCaseStartedId,
    testCaseId,
    timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(scenarioStartMs),
  };

  const testCaseFinished: TestCaseFinished = {
    testCaseStartedId,
    timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(scenarioStopMs),
    willBeRetried: false,
  };

  return { newHooks, testCase, testCaseStarted, testCaseFinished, steps };
}
