import { formatValidationIssues } from "../issues/format-issues.js";
import { parseStepReturns } from "../step/parse-returns.js";
import type { NukadokoConfig } from "../config/schema.js";
import type { StepContextHandle } from "../context/create-context.js";
import type { FixtureGraph } from "../fixture/graph.js";
import { resolveFixtures, type FixtureCache } from "../fixture/resolver.js";
import type { ClaimComparisonRecord, ClaimEachRecord, ClaimReading, ErrorKind, FixtureUsageEntry } from "../record/types.js";
import { brokenClaimsMessage } from "../report/summary/claim-line.js";
import { redact } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { types } from "node:util";
import { observeWithheldKeys, pathSegments, sentenceUnreadReason, type Claim } from "../step/claims.js";
import type { FixtureBag } from "../step/context.js";
import { isClaimStep, type ClaimStep, type RunStep, type Step } from "../step/define-step.js";
import {
  claimReads,
  createReadingsLog,
  deepEqual,
  evaluateClaims,
  failedReading,
  pollReadings,
  POLL_INTERVAL_MS,
  readerOf,
  readingOf,
  readKey,
  takeReads,
  claimsEndedEarly,
  unobservedClaims,
  judgingBudget,
  type ArgSide,
  type ClaimInputs,
  type ClaimReads,
  type JudgingBudget,
  type JudgedClaim,
  type PatternTester,
  type PollClock,
  type Reader,
  type Reading,
  type ReadingsLeftOut,
  type ReadingsLog,
} from "../step/evaluate-claims.js";
import { inputCopy, readAt, snapshotKeys, type Read, type Refusal, type Snapshot } from "../step/snapshot.js";
import { startPatternWorker, testPatternInWorker } from "./pattern-worker.js";
import { stepFixtureNames } from "../step/step-fixture-names.js";
import { strictArgsSchema } from "../step/strict-args.js";
import { classifyCaughtError, runWithTimeout } from "./step-deadline.js";

// `nuka do` names where each args key came from, and where each claim
// value was measured, the same way `nuka run` does, and reaches the run
// layer through this file.
export { argOrigins, claimArgSide, sentenceTextOf } from "./arg-origins.js";
export { channelsOfStepRecord, recordedChannels, withMeasured } from "./measured.js";
export type { ChannelText } from "./measured.js";

// Responsibility: one typed step, run once in a ctx the caller already
// holds, after its args are bound. Open the fixture bag, then either call
// `run` under the step's deadline and validate what it returned, or, for
// a claim step (docs/spec.md "Claims"), read its values (`observe`, once
// or polled, or the `from` values alone) and judge every claim. `nuka run`
// (run-scenario.ts) and `nuka do` both run a step through here, so a claim
// is judged the same way on both paths. What happens around it (binding,
// setup refusals, the record, evidence, teardown) stays with the caller.

/** What a claim step read and how its claims came out. */
export interface ClaimExecution {
  /** One entry per declared claim, in declaration order. */
  readonly judged: readonly JudgedClaim[];
  /** `unobserved` when the step read no values: `observe` threw or ran
   * past the deadline, a fixture it names could not be set up, or an input
   * `observe` would receive could not be copied. */
  readonly observation: "observed" | "unobserved";
  /** How many times `observe` ran; `1` for a step with no `observe`, which
   * reads its `from` values once. */
  readonly attempts: number;
  /** A polled step only: what its readings read, bounded
   * (`createReadingsLog`). */
  readonly readings?: readonly ClaimReading[];
  /** A polled step whose log left readings out: how many. */
  readonly readingsLeftOut?: ReadingsLeftOut;
}

export type ValidatedStepOutcome =
  | {
      readonly status: "passed";
      readonly result: unknown;
      /** A step that runs: the snapshot of each key of its result, taken
       * the moment it returned (`snapshotKeys`), which every later `from`
       * value is a fresh copy of. */
      readonly snapshots?: ReadonlyMap<string, Snapshot>;
      readonly fixtureUsage: FixtureUsageEntry[];
      readonly claims?: ClaimExecution;
    }
  | {
      readonly status: "failed";
      readonly error: { readonly message: string; readonly kind: ErrorKind };
      /** What the step's own code threw, for AfterStep hooks; `undefined`
       * when nothing threw (a broken claim, or a result that did not
       * validate). */
      readonly thrown: unknown;
      readonly fixtureUsage: FixtureUsageEntry[];
      readonly claims?: ClaimExecution;
    };

export interface RunValidatedStepInput {
  readonly name: string;
  readonly step: Step;
  /** The args after validation. */
  readonly args: unknown;
  /** A claim step only: the snapshot of each args value a claim reads,
   * taken before the args schema ran (`snapshotClaimArgs`). */
  readonly claimArgs?: ReadonlyMap<string, Read>;
  readonly handle: StepContextHandle;
  readonly fixtureGraph: FixtureGraph;
  readonly scenarioCache: FixtureCache;
  readonly processCache: FixtureCache;
  readonly config: Pick<NukadokoConfig, "fixtureTimeout" | "stepTimeout">;
  /** Where an args key's value starts, for a claim record
   * (`claimArgSide`). Read only for a claim step. */
  readonly argSide: (key: string) => ArgSide;
  /** The text the line states an args key as (`sentenceTextOf`), or
   * `null`. Read only for a claim step. */
  readonly sentenceText: (key: string) => string | null;
  /** The args key the line's docstring or table filled, and which one;
   * absent when the line carries neither. Read only for a claim step. */
  readonly attachment?: { readonly key: string; readonly kind: "docstring" | "table" };
  /** Each args key the matched pattern fills with a parameter type that
   * has a transformer, with why a claim that compares with it is not
   * judged (`transformedFillReason`). Read only for a claim step. */
  readonly transformed?: ReadonlyMap<string, string>;
  /** The values the records redact. A claim's failure message is built
   * from redacted records, since a message cut to its first difference
   * can cut a secret where redacting the message afterwards no longer
   * finds it. */
  readonly secrets: SecretSet;
  /** Injected by tests; the wall clock otherwise. */
  readonly clock?: PollClock;
}

const WALL_CLOCK: PollClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deadlineOf(step: Step, config: RunValidatedStepInput["config"]): { readonly ms: number | undefined; readonly source: "step" | "config" } {
  return { ms: step.timeout ?? config.stepTimeout, source: step.timeout === undefined ? "config" : "step" };
}

/** The snapshot of each args value a claim step's claims read: a sentence
 * value after its parameter type, a `from` value as the producing step
 * recorded it. A caller takes it before the args schema runs, so nothing
 * the schema does (a refine that writes, a default, a transform changed
 * after defineStep) reaches what the claims judge; `undefined` for a step
 * that runs. `refusedFrom` names each `from` key whose value the producing
 * step's snapshot refused, with the refusal: the args hold that value as
 * it was returned, for a step that runs, and a claim reading any part of
 * it is not judged. */
export function snapshotClaimArgs(step: Step, rawArgs: unknown, refusedFrom: ReadonlyMap<string, Refusal> = new Map()): ReadonlyMap<string, Read> | undefined {
  if (!isClaimStep(step)) return undefined;
  const paths = claimReads(step.claims, new Set(Object.keys(step.from))).args;
  const reads = new Map(takeReads(rawArgs, paths.filter((segments) => !refusedFrom.has(segments[0]!))));
  for (const segments of paths) {
    const refusal = refusedFrom.get(segments[0]!);
    if (refusal !== undefined) reads.set(readKey(segments), { refused: { ...refusal, at: [segments[0]!, ...refusal.at] } });
  }
  return reads;
}

/** Whether two reads of one place found one value. */
function sameRead(before: Read, now: Read): boolean {
  if ("missing" in before) return "missing" in now;
  return "value" in before && "value" in now && deepEqual(before.value, now.value);
}

/** Where the args schema's output differs from what nukadoko read before
 * it ran, at the places the claims read and nowhere else: a value a claim
 * compares whole, and inside each item of an array an `each` reads, the
 * places its `where` and item claims read, with the item count. A key the
 * schema strips that no claim reads changes nothing a claim judges. A
 * value the snapshot could not take is left to that refusal. */
function changedBySchema(before: ReadonlyMap<string, Read>, reads: ClaimReads, after: unknown): ClaimInputs["schemaChanged"] {
  const whole = new Map<string, readonly string[]>();
  for (const segments of reads.argValues) {
    const read = before.get(readKey(segments));
    if (read === undefined || "refused" in read) continue;
    if (!sameRead(read, readAt(after, segments))) whole.set(readKey(segments), segments);
  }
  const itemwise = new Map<string, readonly string[]>();
  for (const { segments, inside } of reads.argItems) {
    const read = before.get(readKey(segments));
    if (read === undefined || !("value" in read) || !Array.isArray(read.value)) continue;
    const items: readonly unknown[] = read.value;
    // An item past the end that is there now is an item the schema added.
    const added = readAt(after, [...segments, String(items.length)]);
    if (!("missing" in added)) {
      itemwise.set(readKey(segments), segments);
      continue;
    }
    found: for (let index = 0; index < items.length; index += 1) {
      for (const path of inside) {
        const place = [...segments, String(index), ...path];
        if (!sameRead(readAt(items[index], path), readAt(after, place))) {
          itemwise.set(readKey(segments), place);
          break found;
        }
      }
    }
  }
  return (segments, byItem) => (byItem ? itemwise : whole).get(readKey(segments)) ?? null;
}

/** Runs `step` with args that already validated. Never throws: every
 * failure is an outcome. */
export async function runValidatedStep(input: RunValidatedStepInput): Promise<ValidatedStepOutcome> {
  return isClaimStep(input.step) ? runClaimStep(input, input.step) : runRunStep(input, input.step);
}

async function runRunStep(input: RunValidatedStepInput, step: RunStep): Promise<ValidatedStepOutcome> {
  const { name, handle, config } = input;
  let fixtureUsage: FixtureUsageEntry[] = [];
  try {
    // Inside the try: a browser launch, a fixture setup, or a broken
    // use() contract fails the step the same way its own throw does.
    const resolved = await resolveFixtures({
      names: stepFixtureNames(step),
      graph: input.fixtureGraph,
      ctx: handle.ctx,
      scenarioCache: input.scenarioCache,
      processCache: input.processCache,
      defaultTimeoutMs: config.fixtureTimeout,
    });
    fixtureUsage = resolved.usage;
    // Opens the step's root call frame before `run`, so `ctx.call` is
    // ready the moment the body could reach for it (docs/spec.md "Parts").
    handle.beginStepRun(step, resolved.fixtures);
    const deadline = deadlineOf(step, config);
    // `Promise.resolve`: `run` may return its value synchronously, and the
    // deadline races a real promise.
    const runResult = await runWithTimeout(
      () => handle.recordingProcesses(() => Promise.resolve(step.run(resolved.fixtures, input.args))),
      deadline.ms,
      "Step",
      name,
      deadline.source,
    );
    const returnsResult = parseStepReturns(step, runResult);
    if (!returnsResult.success) {
      return { status: "failed", error: { message: returnsResult.message, kind: "result_invalid" }, thrown: undefined, fixtureUsage };
    }
    // Taken before anything else runs, so a value the step keeps a
    // reference to and changes later (on a timer, in a callback) is not
    // what a later step receives.
    return { status: "passed", result: returnsResult.data, snapshots: snapshotKeys(returnsResult.data), fixtureUsage };
  } catch (error) {
    // A deadline arrives as the timeout error and records as "timeout",
    // not as the step's own throw.
    return { status: "failed", error: { message: messageOf(error), kind: classifyCaughtError(error) }, thrown: error, fixtureUsage };
  }
}

/** A copy of each args key `observe` receives (every key but a withheld
 * one), or the first key that cannot be copied and why. Made once per
 * step; each call of `observe` gets a clone of it (`observeInputs`). */
function observeInputCopies(
  args: Readonly<Record<string, unknown>>,
  withheld: { has(key: string): boolean },
): { readonly copies: Readonly<Record<string, unknown>> } | { readonly key: string; readonly problem: string } {
  const copies: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (withheld.has(key)) continue;
    const copied = inputCopy(value);
    if ("problem" in copied) return { key, problem: copied.problem };
    Object.defineProperty(copies, key, { value: copied.value, enumerable: true, writable: true, configurable: true });
  }
  return { copies };
}

/** What `observe` receives: a clone of `copies`, new for each call, so
 * nothing `observe` does to its inputs reaches an earlier step's result,
 * another reading, or a value a claim judges. A clone of a clone always
 * succeeds. Reading an expected key throws, so a JavaScript step file,
 * which the `ObserveInputs` type does not reach, cannot pick what to read
 * by the value it will be compared with either; the throw records the
 * step as unobserved, naming the key. */
function observeInputs(
  copies: Readonly<Record<string, unknown>>,
  withheld: ReadonlyMap<string, "expected" | "actual">,
  stepName: string,
): Readonly<Record<string, unknown>> {
  const visible = structuredClone(copies) as Record<string, unknown>;
  return new Proxy(visible, {
    get(target, key, receiver) {
      const side = typeof key === "string" ? withheld.get(key) : undefined;
      if (side === "expected") {
        throw new Error(
          `observe of step "${stepName}" read "${String(key)}", which a claim names as its expected value. ` +
            "observe reads the world, and the claim compares what it read with the expected value",
        );
      }
      if (side === "actual") {
        throw new Error(
          `observe of step "${stepName}" read "${String(key)}", which a claim reads as its actual value and compares with a value observe returns. ` +
            "observe reads the world, and the claim compares what it read with the actual value",
        );
      }
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
}

const NONE_SHADOWED: ReadonlySet<string> = new Set();

/** The time one judging may take when the step has no deadline at all,
 * which only a caller that passes no `stepTimeout` can arrange. */
export const PATTERN_LIMIT_MS = 10_000;

function testsPatterns(claims: readonly Claim[]): boolean {
  const items = (claim: Claim): readonly { readonly compare: string }[] =>
    claim.each === undefined ? [claim] : [...(claim.each.where ?? []), ...claim.each.claims];
  return claims.some((claim) => items(claim).some((item) => item.compare === "matches"));
}

async function runClaimStep(input: RunValidatedStepInput, step: ClaimStep): Promise<ValidatedStepOutcome> {
  const { name, handle, config } = input;
  const args = (typeof input.args === "object" && input.args !== null ? input.args : {}) as Readonly<Record<string, unknown>>;
  const deadline = deadlineOf(step, config);
  // Redact first, then cut: the message shows part of each value, and a
  // part of a secret no longer matches the secret.
  const failureMessage = (records: readonly (ClaimComparisonRecord | ClaimEachRecord)[]): string =>
    brokenClaimsMessage(redact(records, input.secrets) as typeof records);
  const startedAt = Date.now();
  const testPattern: PatternTester = testPatternInWorker;
  // Judging is bounded by the step's deadline as a whole: every claim,
  // item, and reading takes its time from what is left of it.
  const stepBudget = deadline.ms === undefined ? null : judgingBudget(startedAt + deadline.ms, "the step's deadline");
  const budgetOf = (): JudgingBudget => stepBudget ?? judgingBudget(Date.now() + PATTERN_LIMIT_MS, "the 10 second limit for judging a step with no deadline");
  const fromKeys = new Set(Object.keys(step.from));
  const reads = claimReads(step.claims, fromKeys);
  // A caller that took no snapshot before the schema ran (none does) gets
  // one of the validated args, so no claim reads a live value either way.
  const argReads = input.claimArgs ?? takeReads(args, reads.args);
  const schemaChanged = changedBySchema(argReads, reads, args);
  const noObservation: Reader = readerOf(new Map());
  const withheld = observeWithheldKeys(step.claims, fromKeys);
  // The from keys a claim's actual starts with: a key observe returns
  // under the same name never reaches that claim, so a reading that holds
  // one is recorded beside its reader.
  const actualFromKeys = step.claims.map((claim) => pathSegments(claim.actual)?.[0] ?? "").filter((key) => fromKeys.has(key));
  const shadowsOf = new WeakMap<Reader, ReadonlySet<string>>();
  const observeReceived = step.observe === undefined ? [] : Object.keys(args).filter((key) => !withheld.has(key));
  const claimInputs = (observed: Reader): ClaimInputs => ({
    args: readerOf(argReads),
    observed,
    shadowedByObserve: shadowsOf.get(observed) ?? NONE_SHADOWED,
    schemaChanged,
    fromKeys,
    observeReceived,
    argSide: input.argSide,
    sentenceText: input.sentenceText,
    transformed: (key) => input.transformed?.get(key) ?? null,
    patterns: step.patterns,
    testPattern,
    budget: budgetOf(),
  });
  let fixtureUsage: FixtureUsageEntry[] = [];
  let attempts = 0;
  // Set for a polled step only, so a step that reads once records none.
  let readings: ReadingsLog | undefined;
  const readingsField = (): { readonly readings?: readonly ClaimReading[]; readonly readingsLeftOut?: ReadingsLeftOut } => {
    if (readings === undefined) return {};
    const kept = readings.kept();
    return kept.left_out === undefined ? { readings: kept.readings } : { readings: kept.readings, readingsLeftOut: kept.left_out };
  };
  const judge = async (observed: Reader): Promise<ValidatedStepOutcome> => {
    const judged = await evaluateClaims(step.claims, claimInputs(observed));
    const claims: ClaimExecution = { judged, observation: "observed", attempts: Math.max(attempts, 1), ...readingsField() };
    const records = judged.map((entry) => entry.record);
    if (records.every((record) => record.outcome === "held")) return { status: "passed", result: {}, fixtureUsage, claims };
    // A claim nukadoko failed to judge is never the criterion failing, so
    // it decides the kind even when another claim broke.
    const kind = records.some((record) => record.outcome === "unjudged") ? "claim_unjudged" : "claim_broken";
    return { status: "failed", error: { message: failureMessage(records), kind }, thrown: undefined, fixtureUsage, claims };
  };
  // What a step whose reading did not end records: `unobserved` only when
  // `observe` itself threw; a fixture that failed to set up is the step's
  // own error, as for a step that runs. A deadline that passed while
  // `observe` ran, or between two readings, is `timeout`, and it is
  // nukadoko's limit rather than `observe` failing, so each claim is
  // `unjudged`, with the readings read so far.
  const readNothing = (error: unknown, whileObserving: boolean): ValidatedStepOutcome => {
    const caught = classifyCaughtError(error);
    const kind = caught === "timeout" ? "timeout" : whileObserving ? "unobserved" : caught;
    const timedOut = caught === "timeout" && whileObserving;
    const why =
      readings === undefined
        ? `${messageOf(error)} while observe ran, so no claim was judged`
        : `${messageOf(error)} while the poll read, so no claim was judged; the readings show what each reading before it read`;
    const judged = timedOut ? claimsEndedEarly(step.claims, claimInputs(noObservation), "unjudged", why) : unobservedClaims(step.claims, claimInputs(noObservation));
    // A poll that read a value before the deadline did observe.
    const read = readings !== undefined && readings.kept().readings.some((reading) => reading.error === undefined);
    return {
      status: "failed",
      error: { message: kind === "unobserved" ? `the step observed nothing, so no claim was judged: ${messageOf(error)}` : messageOf(error), kind },
      thrown: error,
      fixtureUsage,
      claims: { judged, observation: timedOut && read ? "observed" : "unobserved", attempts, ...readingsField() },
    };
  };
  // Static, so before any fixture is set up: a line whose docstring or
  // table states a value no claim reads is a criterion the step does not
  // judge, as `nuka check` reports (`claim-sentence-unread`).
  const unread =
    input.attachment === undefined ? null : sentenceUnreadReason(step.claims, step.observe !== undefined, input.attachment.key, input.attachment.kind);
  if (unread !== null) {
    const judged = claimsEndedEarly(step.claims, claimInputs(noObservation), "broken", unread);
    return {
      status: "failed",
      error: { message: failureMessage(judged.map((entry) => entry.record)), kind: "claim_broken" },
      thrown: undefined,
      fixtureUsage,
      claims: { judged, observation: "unobserved", attempts: 0 },
    };
  }
  if (testsPatterns(step.claims)) {
    try {
      startPatternWorker();
    } catch {
      // A worker that cannot start (`node --permission` without
      // --allow-worker) fails again when a pattern is tested, and that
      // claim is recorded as unjudged with the reason.
    }
  }
  handle.withholdResults(name);
  let fixtures: FixtureBag;
  try {
    const resolved = await resolveFixtures({
      names: stepFixtureNames(step),
      graph: input.fixtureGraph,
      ctx: handle.ctx,
      scenarioCache: input.scenarioCache,
      processCache: input.processCache,
      defaultTimeoutMs: config.fixtureTimeout,
    });
    fixtureUsage = resolved.usage;
    handle.beginStepRun(step, resolved.fixtures);
    fixtures = resolved.fixtures;
  } catch (error) {
    return readNothing(error, false);
  }
  const observe = step.observe;
  if (observe === undefined) return judge(noObservation);
  const inputCopies = observeInputCopies(args, withheld);
  if ("problem" in inputCopies) {
    // observe would receive a reference into a value step code holds, so
    // nothing it read could be trusted to be a reading of the world.
    const reason =
      `observe would receive args.${inputCopies.key}, which ${inputCopies.problem}, and observe receives only copies of its inputs, ` +
      "so observe did not run and no claim was judged";
    const judged = claimsEndedEarly(step.claims, claimInputs(noObservation), "unjudged", reason);
    return {
      status: "failed",
      error: { message: failureMessage(judged.map((entry) => entry.record)), kind: "claim_unjudged" },
      thrown: undefined,
      fixtureUsage,
      claims: { judged, observation: "unobserved", attempts: 0 },
    };
  }
  const copies = inputCopies.copies;
  const takeObserved = (value: unknown): Reader => {
    const reader = readerOf(takeReads(value, reads.observed));
    const shadowed = typeof value === "object" && value !== null && !types.isProxy(value) ? actualFromKeys.filter((key) => Object.hasOwn(value, key)) : [];
    if (shadowed.length > 0) shadowsOf.set(reader, new Set(shadowed));
    return reader;
  };
  // The snapshot is taken the moment observe returns, before anything else
  // runs: a value it returned and changes later (on a timer, in a promise
  // callback, on the next reading) is not what the claims read.
  const callObserve = (): Reader | Promise<Reader> => {
    attempts += 1;
    const returned: unknown = observe(fixtures, observeInputs(copies, withheld, name));
    return isThenable(returned) ? Promise.resolve(returned).then(takeObserved) : takeObserved(returned);
  };
  const poll = step.poll;
  if (poll === undefined || poll === false) {
    let value: Reader;
    try {
      value = await runWithTimeout(
        () => handle.recordingProcesses(() => Promise.resolve(callObserve())),
        deadline.ms,
        "Step",
        name,
        deadline.source,
      );
    } catch (error) {
      return readNothing(error, true);
    }
    return judge(value);
  }
  // Set once the step's deadline fires, so a poll still running in the
  // background stops at its next reading instead of reading a world the
  // scenario has moved past.
  let abandoned = false;
  const clock = input.clock ?? WALL_CLOCK;
  const log = createReadingsLog();
  readings = log;
  const readingAt = (): string => new Date(clock.now()).toISOString();
  const read = async (): Promise<Reading> => {
    if (abandoned) throw new Error("the step's deadline passed");
    try {
      return { ok: true, value: await callObserve() };
    } catch (error) {
      log.add(failedReading(attempts, readingAt(), error));
      return { ok: false, error };
    }
  };
  const holds = async (value: unknown): Promise<boolean> => {
    const judged = await evaluateClaims(step.claims, claimInputs(value as Reader));
    const { reading, content } = readingOf(attempts, readingAt(), judged);
    log.add(reading, content);
    return reading.held;
  };
  // A poll does not outlast the step: the deadline's timer starts with the
  // poll, and the poll stops one interval before it, so its last reading
  // starts in time and is judged, where a poll longer than the step would
  // always end in the deadline, with no reading judged.
  const pollTimeout = deadline.ms === undefined ? poll.timeout_ms : Math.max(0, Math.min(poll.timeout_ms, deadline.ms - POLL_INTERVAL_MS));
  let polled: { readonly last: Reading; readonly attempts: number };
  try {
    polled = await runWithTimeout(
      () => handle.recordingProcesses(() => pollReadings(read, holds, pollTimeout, clock)),
      deadline.ms,
      "Step",
      name,
      deadline.source,
    );
  } catch (error) {
    abandoned = true;
    return readNothing(error, true);
  }
  if (!polled.last.ok) return readNothing(polled.last.error, true);
  return judge(polled.last.value as Reader);
}

/** Whether `value` is a promise or another thenable `observe` returned. A
 * Proxy is not asked: its snapshot refuses it without running a trap. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== "object" && typeof value !== "function") return false;
  if (value === null || types.isProxy(value)) return false;
  return typeof (value as { then?: unknown }).then === "function";
}

// --- nuka do ---

export interface ExecuteTypedStepInput {
  readonly name: string;
  readonly step: Step;
  readonly args: unknown;
  readonly handle: StepContextHandle;
  readonly fixtureGraph: FixtureGraph;
  readonly scenarioCache: FixtureCache;
  readonly processCache: FixtureCache;
  readonly config: Pick<NukadokoConfig, "fixtureTimeout" | "stepTimeout">;
  readonly argSide: (key: string) => ArgSide;
  readonly sentenceText: (key: string) => string | null;
  readonly secrets: SecretSet;
}

/** `args` is the validated value once validation passed, and the value
 * given otherwise, so a record never shows a key validation rejected or a
 * default it filled in silently. */
export type TypedStepOutcome =
  | {
      readonly status: "passed";
      readonly args: unknown;
      readonly result: unknown;
      readonly fixtureUsage: FixtureUsageEntry[];
      readonly claims?: ClaimExecution;
    }
  | {
      readonly status: "failed";
      readonly args: unknown;
      readonly error: { readonly message: string; readonly kind: ErrorKind };
      readonly fixtureUsage: FixtureUsageEntry[];
      readonly claims?: ClaimExecution;
    };

/** Validates the args, then runs the step through `runValidatedStep`.
 * `nuka do` runs a step through this function. */
export async function executeTypedStep(input: ExecuteTypedStepInput): Promise<TypedStepOutcome> {
  const claimArgs = snapshotClaimArgs(input.step, input.args);
  const argsResult = strictArgsSchema(input.step.args).safeParse(input.args);
  if (!argsResult.success) {
    return {
      status: "failed",
      args: input.args,
      error: { message: `args validation failed: ${formatValidationIssues(argsResult.error.issues)}`, kind: "args_invalid" },
      fixtureUsage: [],
    };
  }
  const outcome = await runValidatedStep({ ...input, args: argsResult.data, ...(claimArgs === undefined ? {} : { claimArgs }) });
  const claims = outcome.claims === undefined ? {} : { claims: outcome.claims };
  if (outcome.status === "passed") {
    return { status: "passed", args: argsResult.data, result: outcome.result, fixtureUsage: outcome.fixtureUsage, ...claims };
  }
  return { status: "failed", args: argsResult.data, error: outcome.error, fixtureUsage: outcome.fixtureUsage, ...claims };
}
