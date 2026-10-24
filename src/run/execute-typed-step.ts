import { formatValidationIssues } from "../issues/format-issues.js";
import { parseStepReturns } from "../step/parse-returns.js";
import type { NukadokoConfig } from "../config/schema.js";
import type { StepContextHandle } from "../context/create-context.js";
import type { FixtureGraph } from "../fixture/graph.js";
import { resolveFixtures, type FixtureCache } from "../fixture/resolver.js";
import type { ErrorKind, FixtureUsageEntry } from "../record/types.js";
import { brokenClaimsMessage } from "../report/summary/claim-line.js";
import { pathSegments, type Claim } from "../step/claims.js";
import type { FixtureBag } from "../step/context.js";
import { isClaimStep, type ClaimStep, type RunStep, type Step } from "../step/define-step.js";
import {
  evaluateClaims,
  pollReadings,
  unobservedClaims,
  type ClaimInputs,
  type JudgedClaim,
  type PollClock,
  type Reading,
} from "../step/evaluate-claims.js";
import { stepFixtureNames } from "../step/step-fixture-names.js";
import { strictArgsSchema } from "../step/strict-args.js";
import { classifyCaughtError, runWithTimeout } from "./step-deadline.js";

// `nuka do` names where each args key came from, and where each claim
// value was measured, the same way `nuka run` does, and reaches the run
// layer through this file.
export { argOrigins, claimSourceLabel } from "./arg-origins.js";
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
  /** `unobserved` when the step could not read its values: `observe` threw
   * or ran past the deadline, or a fixture it names could not be set up. */
  readonly observation: "observed" | "unobserved";
  /** How many times `observe` ran; `1` for a step with no `observe`, which
   * reads its `from` values once. */
  readonly attempts: number;
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
  readonly handle: StepContextHandle;
  readonly fixtureGraph: FixtureGraph;
  readonly scenarioCache: FixtureCache;
  readonly processCache: FixtureCache;
  readonly config: Pick<NukadokoConfig, "fixtureTimeout" | "stepTimeout">;
  /** The source a claim record names for an args key
   * (`claimSourceLabel`). Read only for a claim step. */
  readonly argLabel: (key: string) => string;
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

/** What `observe` receives: the args without the expected keys. Reading
 * one of those keys throws, so a JavaScript step file, which the
 * `ObserveInputs` type does not reach, cannot pick what to read by the
 * value it will be compared with either; the throw records the step as
 * unobserved, naming the key. */
function observeInputs(args: Readonly<Record<string, unknown>>, withheld: ReadonlySet<string>, stepName: string): Readonly<Record<string, unknown>> {
  const visible = Object.freeze(Object.fromEntries(Object.entries(args).filter(([key]) => !withheld.has(key))));
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

async function runClaimStep(input: RunValidatedStepInput, step: ClaimStep): Promise<ValidatedStepOutcome> {
  const { name, handle, config } = input;
  const args = (typeof input.args === "object" && input.args !== null ? input.args : {}) as Readonly<Record<string, unknown>>;
  const claimInputs = (observation: unknown): ClaimInputs => ({
    args,
    observation,
    fromKeys: new Set(Object.keys(step.from)),
    argLabel: input.argLabel,
    patterns: step.patterns,
  });
  let fixtureUsage: FixtureUsageEntry[] = [];
  let attempts = 0;
  const judge = (observation: unknown): ValidatedStepOutcome => {
    const judged = evaluateClaims(step.claims, claimInputs(observation));
    const claims: ClaimExecution = { judged, observation: "observed", attempts: Math.max(attempts, 1) };
    const records = judged.map((entry) => entry.record);
    if (records.every((record) => record.outcome === "held")) return { status: "passed", result: {}, fixtureUsage, claims };
    return { status: "failed", error: { message: brokenClaimsMessage(records), kind: "claim_broken" }, thrown: undefined, fixtureUsage, claims };
  };
  const unobserved = (error: unknown): ValidatedStepOutcome => {
    const kind = classifyCaughtError(error) === "timeout" ? "timeout" : "unobserved";
    return {
      status: "failed",
      error: { message: kind === "timeout" ? messageOf(error) : `the step observed nothing, so no claim was judged: ${messageOf(error)}`, kind },
      thrown: error,
      fixtureUsage,
      claims: { judged: unobservedClaims(step.claims, claimInputs(undefined)), observation: "unobserved", attempts },
    };
  };
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
    const observe = step.observe;
    if (observe === undefined) return judge(undefined);
    const inputs = observeInputs(args, expectedKeys(step.claims), name);
    const fixtures: FixtureBag = resolved.fixtures;
    const deadline = deadlineOf(step, config);
    const poll = step.poll;
    if (poll === undefined || poll === false) {
      const value = await runWithTimeout(
        () =>
          handle.recordingProcesses(() => {
            attempts += 1;
            return Promise.resolve(observe(fixtures, inputs));
          }),
        deadline.ms,
        "Step",
        name,
        deadline.source,
      );
      return judge(value);
    }
    // Set once the step's deadline fires, so a poll still running in the
    // background stops at its next reading instead of reading a world the
    // scenario has moved past.
    let abandoned = false;
    const read = async (): Promise<Reading> => {
      if (abandoned) throw new Error("the step's deadline passed");
      attempts += 1;
      try {
        return { ok: true, value: await observe(fixtures, inputs) };
      } catch (error) {
        return { ok: false, error };
      }
    };
    const holds = (value: unknown): boolean =>
      evaluateClaims(step.claims, claimInputs(value)).every((entry) => entry.record.outcome === "held");
    let polled: { readonly last: Reading; readonly attempts: number };
    try {
      polled = await runWithTimeout(
        () => handle.recordingProcesses(() => pollReadings(read, holds, poll.timeout_ms, input.clock ?? WALL_CLOCK)),
        deadline.ms,
        "Step",
        name,
        deadline.source,
      );
    } catch (error) {
      abandoned = true;
      throw error;
    }
    if (!polled.last.ok) return unobserved(polled.last.error);
    return judge(polled.last.value);
  } catch (error) {
    return unobserved(error);
  }
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
  readonly argLabel: (key: string) => string;
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
  const argsResult = strictArgsSchema(input.step.args).safeParse(input.args);
  if (!argsResult.success) {
    return {
      status: "failed",
      args: input.args,
      error: { message: `args validation failed: ${formatValidationIssues(argsResult.error.issues)}`, kind: "args_invalid" },
      fixtureUsage: [],
    };
  }
  const outcome = await runValidatedStep({ ...input, args: argsResult.data });
  const claims = outcome.claims === undefined ? {} : { claims: outcome.claims };
  if (outcome.status === "passed") {
    return { status: "passed", args: argsResult.data, result: outcome.result, fixtureUsage: outcome.fixtureUsage, ...claims };
  }
  return { status: "failed", args: argsResult.data, error: outcome.error, fixtureUsage: outcome.fixtureUsage, ...claims };
}
