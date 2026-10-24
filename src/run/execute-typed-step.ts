import { formatValidationIssues } from "../issues/format-issues.js";
import { parseStepReturns } from "../step/parse-returns.js";
import type { NukadokoConfig } from "../config/schema.js";
import type { StepContextHandle } from "../context/create-context.js";
import type { FixtureGraph } from "../fixture/graph.js";
import { resolveFixtures, type FixtureCache } from "../fixture/resolver.js";
import type { ClaimReading, ErrorKind, FixtureUsageEntry } from "../record/types.js";
import { brokenClaimsMessage } from "../report/summary/claim-line.js";
import { types } from "node:util";
import { pathSegments, type Claim } from "../step/claims.js";
import type { FixtureBag } from "../step/context.js";
import { isClaimStep, type ClaimStep, type RunStep, type Step } from "../step/define-step.js";
import {
  claimReads,
  createReadingsLog,
  deepEqual,
  evaluateClaims,
  failedReading,
  pollReadings,
  readerOf,
  readingOf,
  readKey,
  takeReads,
  unobservedClaims,
  type ArgSide,
  type ClaimInputs,
  type JudgedClaim,
  type PatternTester,
  type PollClock,
  type Reader,
  type Reading,
  type ReadingsLeftOut,
  type ReadingsLog,
} from "../step/evaluate-claims.js";
import { detachedCopy, readAt, type Read } from "../step/snapshot.js";
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
   * past the deadline, or a fixture it names could not be set up. */
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
 * that runs. */
export function snapshotClaimArgs(step: Step, rawArgs: unknown): ReadonlyMap<string, Read> | undefined {
  if (!isClaimStep(step)) return undefined;
  return takeReads(rawArgs, claimReads(step.claims, new Set(Object.keys(step.from))).args);
}

/** Which args values a claim reads came out of the args schema other than
 * nukadoko read them before it ran. A value the snapshot could not take is
 * left to that refusal. */
function changedBySchema(before: ReadonlyMap<string, Read>, paths: readonly (readonly string[])[], after: unknown): (segments: readonly string[]) => boolean {
  const changed = new Set<string>();
  for (const segments of paths) {
    const read = before.get(readKey(segments));
    if (read === undefined || "refused" in read) continue;
    const now = readAt(after, segments);
    const same = "missing" in read ? "missing" in now : "value" in now && deepEqual(read.value, now.value);
    if (!same) changed.add(readKey(segments));
  }
  return (segments) => changed.has(readKey(segments));
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
    return { status: "passed", result: returnsResult.data, fixtureUsage };
  } catch (error) {
    // A deadline arrives as the timeout error and records as "timeout",
    // not as the step's own throw.
    return { status: "failed", error: { message: messageOf(error), kind: classifyCaughtError(error) }, thrown: error, fixtureUsage };
  }
}

/** The args keys a claim names as its expected value: a sentence key, or
 * the `from` key a `{ from }` path starts with. */
export function expectedKeys(claims: readonly Claim[]): ReadonlySet<string> {
  const keys = new Set<string>();
  const add = (expected: unknown): void => {
    if (typeof expected === "string") keys.add(expected);
    else if (typeof expected === "object" && expected !== null && "from" in expected) {
      const head = pathSegments(String((expected as { from: unknown }).from))?.[0];
      if (head !== undefined) keys.add(head);
    }
  };
  for (const claim of claims) {
    if (claim.each === undefined) add(claim.expected);
    else for (const item of [...(claim.each.where ?? []), ...claim.each.claims]) add(item.expected);
  }
  return keys;
}

/** What `observe` receives: a copy of the args without the expected keys,
 * new for each call, so nothing `observe` does to its inputs reaches an
 * earlier step's result or another reading. Reading an expected key
 * throws, so a JavaScript step file, which the `ObserveInputs` type does
 * not reach, cannot pick what to read by the value it will be compared
 * with either; the throw records the step as unobserved, naming the key. */
function observeInputs(args: Readonly<Record<string, unknown>>, withheld: ReadonlySet<string>, stepName: string): Readonly<Record<string, unknown>> {
  const visible = detachedCopy(Object.fromEntries(Object.entries(args).filter(([key]) => !withheld.has(key)))) as Record<string, unknown>;
  return new Proxy(visible, {
    get(target, key, receiver) {
      if (typeof key === "string" && withheld.has(key)) {
        throw new Error(
          `observe of step "${stepName}" read "${key}", which a claim names as its expected value. ` +
            "observe reads the world, and the claim compares what it read with the expected value",
        );
      }
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
}

/** The time a `matches` pattern may take when the step has no deadline at
 * all, which only a caller that passes no `stepTimeout` can arrange. */
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
  const startedAt = Date.now();
  const testPattern: PatternTester = (pattern, text) =>
    deadline.ms === undefined
      ? testPatternInWorker(pattern, text, PATTERN_LIMIT_MS, "the limit for a step with no deadline")
      : testPatternInWorker(pattern, text, Math.max(1, startedAt + deadline.ms - Date.now()), "the time left of the step's deadline");
  const fromKeys = new Set(Object.keys(step.from));
  const reads = claimReads(step.claims, fromKeys);
  // A caller that took no snapshot before the schema ran (none does) gets
  // one of the validated args, so no claim reads a live value either way.
  const argReads = input.claimArgs ?? takeReads(args, reads.args);
  const schemaChanged = changedBySchema(argReads, reads.args, args);
  const noObservation: Reader = readerOf(new Map());
  const claimInputs = (observed: Reader): ClaimInputs => ({
    args: readerOf(argReads),
    observed,
    schemaChanged,
    fromKeys,
    argSide: input.argSide,
    sentenceText: input.sentenceText,
    patterns: step.patterns,
    testPattern,
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
    return { status: "failed", error: { message: brokenClaimsMessage(records), kind }, thrown: undefined, fixtureUsage, claims };
  };
  // What a step that read nothing records: `unobserved` as the kind only
  // when `observe` itself threw; a deadline is `timeout` and a fixture that
  // failed to set up is the step's own error, as for a step that runs.
  const readNothing = (error: unknown, observeThrew: boolean): ValidatedStepOutcome => {
    const caught = classifyCaughtError(error);
    const kind = caught === "timeout" ? "timeout" : observeThrew ? "unobserved" : caught;
    return {
      status: "failed",
      error: { message: kind === "unobserved" ? `the step observed nothing, so no claim was judged: ${messageOf(error)}` : messageOf(error), kind },
      thrown: error,
      fixtureUsage,
      claims: { judged: unobservedClaims(step.claims, claimInputs(noObservation)), observation: "unobserved", attempts, ...readingsField() },
    };
  };
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
  const withheld = expectedKeys(step.claims);
  const takeObserved = (value: unknown): Reader => readerOf(takeReads(value, reads.observed));
  // The snapshot is taken the moment observe returns, before anything else
  // runs: a value it returned and changes later (on a timer, in a promise
  // callback, on the next reading) is not what the claims read.
  const callObserve = (): Reader | Promise<Reader> => {
    attempts += 1;
    const returned: unknown = observe(fixtures, observeInputs(args, withheld, name));
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
    const reading = readingOf(attempts, readingAt(), judged);
    log.add(reading);
    return reading.held;
  };
  let polled: { readonly last: Reading; readonly attempts: number };
  try {
    polled = await runWithTimeout(
      () => handle.recordingProcesses(() => pollReadings(read, holds, poll.timeout_ms, clock)),
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
