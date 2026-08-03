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
import type { Receipt } from "../../receipt/types.js";
import type { ScenarioHookRecord, ScenarioRecord, ScenarioStepRecord, ScenarioStepStatus } from "../../run/record-types.js";
import { contentTypeForFileName } from "../media-type.js";

// Responsibility: the pure transform at the center of this module (this
// task's spec, decision 1: map-scenario.ts is a pure function that
// assembles one scenario's worth of envelope material and never touches
// the filesystem) — `(record, receipts,
// pickle, newId, hookIds) -> cucumber-messages envelope material for one
// scenario`. No `node:fs` anywhere in this file: every input is already
// resolved by the caller (src/report/messages/emitter.ts reads receipt.json
// files via src/report/receipts.ts before calling this), so this module can
// be driven entirely from fixture data in a test, no real NDJSON stream and
// no real IdGenerator anywhere in the call graph — `newId` is passed in
// specifically so a test can substitute `IdGenerator.incrementing()` for
// deterministic ids (this task's spec, decision 11).
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
// message bodies; src/report/messages/emitter.ts (the only place that
// touches `node:fs`) wraps each one and decides the on-disk order (this
// task's spec, decision 4).

/** A declared file attachment still needs its bytes read and base64-encoded
 * (I/O — emitter.ts's job); a declared log line is already a complete
 * `Attachment` body (no file to read, so this task's spec, decision 9's own
 * always-BASE64-since-either-encoding-is-lossless reasoning doesn't apply
 * to it — IDENTITY is pinned for logs specifically) and so is built here in
 * full. Keeping
 * both cases in one discriminated union (rather than two parallel lists)
 * preserves declared.attachments-then-declared.logs order as a single
 * ordered sequence for the emitter to walk. */
export type MessagesAttachmentPlan =
  | {
      readonly kind: "file";
      readonly testCaseStartedId: string;
      readonly testStepId: string;
      readonly fileName: string;
      readonly mediaType: string;
      /** Root-relative path (rootDir + this) — emitter.ts resolves and
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
export const CUCUMBER_LOG_MEDIA_TYPE = "text/x.cucumber.log+plain";

function joinRelative(dir: string, fileName: string): string {
  return `${dir.replace(/\/+$/, "")}/${fileName}`;
}

// `declared.attachments`/`declared.logs` (this task's spec, decision 9) —
// the only two `declared` sub-fields this module reads. `declared.labels`/
// `links`/`parameters` have no home in the messages protocol's closed
// schema and are dropped here (known limit, documented in spec-b, not this
// slice's docs work).
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

function statusForHook(status: "ok" | "failed"): TestStepResultStatus {
  return status === "ok" ? TestStepResultStatus.PASSED : TestStepResultStatus.FAILED;
}

// Duration never negative (this task's spec, decision 8: round to 0 when
// duration would otherwise go negative) — a receiptless step pinned to the previous step's
// own stop is always zero-width by construction, but a real receipt's own
// started_at/finished_at pair is operator-authored input this module has no
// way to fully trust.
function buildResult(status: TestStepResultStatus, message: string | undefined, startMs: number, stopMs: number): TestStepResult {
  return {
    status,
    duration: TimeConversion.millisecondsToDuration(Math.max(stopMs - startMs, 0)),
    ...(message !== undefined ? { message } : {}),
    // `exception` is never set (this task's spec, decision 7): `Exception.
    // type` is required and record/receipt only ever carry a message, never
    // a type string worth reporting as fact.
  };
}

export interface MappedTestStep {
  readonly testStep: TestStep;
  readonly testStepStarted: TestStepStarted;
  readonly testStepFinished: TestStepFinished;
  /** Emitted between `testStepStarted` and `testStepFinished` (this task's
   * spec, decision 9 — that's what cucumber's own runner does). */
  readonly attachments: readonly MessagesAttachmentPlan[];
}

function mapPickleSteps(
  record: ScenarioRecord,
  receipts: ReadonlyMap<string, Receipt | null>,
  pickleSteps: readonly PickleStep[],
  scenarioStartMs: number,
  testCaseStartedId: string,
  newId: () => string,
): MappedTestStep[] {
  let previousStopMs = scenarioStartMs;
  return record.steps.map((step, index): MappedTestStep => {
    const receipt = step.receipt !== null ? (receipts.get(step.receipt) ?? undefined) : undefined;

    let startMs: number;
    let stopMs: number;
    if (receipt) {
      startMs = Date.parse(receipt.started_at);
      stopMs = Date.parse(receipt.finished_at);
    } else {
      // Same zero-width-pinned-to-previous-stop rule as
      // src/report/allure/map-scenario.ts:483-496 (this task's spec,
      // decision 8: it would be a bug for the two emitters to show
      // different timelines built from the same record).
      startMs = previousStopMs;
      stopMs = previousStopMs;
    }
    previousStopMs = stopMs;

    const testStepId = newId();
    const pickleStepId = pickleSteps[index]?.id;
    const attachments = receipt
      ? declaredAttachmentPlans(receipt.declared, receipt.evidence.dir, testCaseStartedId, testStepId)
      : [];

    return {
      testStep: {
        id: testStepId,
        // `stepDefinitionIds`/`stepMatchArgumentsLists` deliberately never
        // set (this task's spec, decision 7) — omitted keys, not `undefined`
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
        testStepResult: buildResult(statusForStep(step.status), step.error?.message, startMs, stopMs),
      },
      attachments,
    };
  });
}

// `hookId` is now a resolver, not a single fixed string (t7-afterstep-
// consumers task spec, item 1): a "before"/"after" call site still always
// returns the same id (one Hook definition, same as before this change),
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
    // "after_step") = scenario finish, all zero-width (this task's spec,
    // decision 8, extended by t7-afterstep-consumers task spec, item 1 to
    // "after_step" — record.json carries no per-hook timestamp of its own,
    // the same known limit src/report/allure/emitter.ts's own header
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
 * run-wide slot it fills (this task's spec, decision 6: created lazily, on
 * first need) — `hookIds.before`/`hookIds.after` for `"before"`/`"after"`,
 * or `hookIds.afterStep[stepIndex]` for `"after_step"` (t7-afterstep-
 * consumers task spec, item 1: one Hook definition per distinct
 * `step_index`, not one for the whole run, since each needs its own
 * `AfterStep[<index>]` name). */
export type NewHookEnvelope =
  | { readonly type: "before" | "after"; readonly hook: Hook }
  | { readonly type: "after_step"; readonly stepIndex: number; readonly hook: Hook };

export interface MapScenarioInput {
  readonly record: ScenarioRecord;
  /** Already-read receipts, keyed by receipt id — `null` for an id whose
   * receipt.json couldn't be read/parsed. A step whose own
   * `record.steps[].receipt` isn't a key here at all is treated the same as
   * one mapped to `null`. */
  readonly receipts: ReadonlyMap<string, Receipt | null>;
  readonly pickle: Pickle;
  readonly newId: () => string;
  /** The `Hook` id(s) already assigned earlier in this run (this task's
   * spec, decision 6) — `undefined`/absent means not yet assigned; this call
   * then allocates one via `newId` and returns it in `newHooks` for the
   * caller (emitter.ts) to remember for every later scenario.
   * `afterStep` is keyed by `step_index` (t7-afterstep-consumers task
   * spec, item 1) — one id per index, not one for the whole run, since each
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
   * then after_step-hook test steps, then after-hook test steps (this
   * task's spec, decision 7, extended by t7-afterstep-consumers task spec,
   * item 1) — also exactly `testCase.testSteps`' own order. `after_step`
   * sits before `after`, not after it, even though both collapse to the
   * same zero-width `scenarioStopMs` instant (this file's own `mapHookSteps`
   * comment): every AfterStep hook actually finishes, in real execution,
   * before the scenario-level After hook ever starts, so this is the one
   * place that relative fact can still be preserved even though the exact
   * timestamps can't be. */
  readonly steps: readonly MappedTestStep[];
}

export function mapScenario(input: MapScenarioInput): MappedScenario {
  const { record, receipts, pickle, newId, hookIds } = input;
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

  // AfterStep (t7-afterstep-consumers task spec, item 1): one Hook
  // definition per distinct `step_index`, created lazily and reused across
  // the run the same way before/after are (`hookIds.afterStep`, threaded in
  // by emitter.ts) — not folded onto the existing "after" Hook id, since
  // that would give every AfterStep occurrence the same "After" name and
  // erase exactly the fact this task exists to stop dropping (which step it
  // ran after). `type: HookType.AFTER_TEST_STEP` is the protocol's own
  // existing concept for a step-level hook (messages.d.ts's `HookType`
  // enum) — using it, rather than reusing `AFTER_TEST_CASE`, is not "a new
  // concept on the cucumber-messages side" (the thing this task's spec rules
  // out); it is the concept the protocol already ships for exactly this
  // case. `Hook.name` still folds the index in (`AfterStep[<index>]`, same
  // as src/report/allure/map-scenario.ts's own `mapHooks`) because
  // `TestStep` itself has no field of its own to carry "which step" — only
  // `hookId`/`pickleStepId` (messages.d.ts's `TestStep`) — so the index has
  // nowhere to live except the Hook definition's own name. `step_index` is
  // guaranteed present on every `"after_step"` record entry
  // (record-types.ts's own contract), hence the `!`.
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
  const pickleSteps = mapPickleSteps(record, receipts, pickle.steps, scenarioStartMs, testCaseStartedId, newId);
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
