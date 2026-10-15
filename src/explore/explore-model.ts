import type { Model } from "../step/define-explore.js";
import { drawFrom, generatedSource, replayedSource, seededUint32, type ChoiceSource } from "./choices.js";
import {
  describeError,
  type OpenSequence,
  type PlannedStep,
  type SequenceFailure,
  type SequenceSession,
  type StepOutcome,
} from "./sequence.js";

// Responsibility: run a model and shrink the first failure it finds.
//
// A run builds a sequence from the model alone: from the state, pick one
// command whose `pre` holds, draw its args, and move the state with
// `next`. Every pick and every draw is one recorded choice. The sequence
// then runs step by step, and `post` judges each result against the state
// before that step. The first failed step, or the first `post` that does
// not hold, ends the run.
//
// Shrinking edits the recorded choices and builds the sequence again from
// them. It first deletes one step's choices, then lowers one choice at a
// time, and keeps an edit only when the rebuilt sequence still fails the
// same way (`sameFailure`). Each
// kept edit makes the choice list shorter, or the same length and
// lexicographically smaller, so shrinking ends. This is the choice-list
// shrinking Hypothesis uses, cut down to its two simplest passes.

export const DEFAULT_MAX_SHRINK_ATTEMPTS = 200;

export interface ExploreModelOptions {
  readonly model: Model;
  readonly seed: number;
  readonly runs: number;
  readonly length: number;
  readonly open: OpenSequence;
  readonly maxShrinkAttempts?: number;
}

export type ExploreModelResult =
  | { readonly status: "passed"; readonly seed: number; readonly runs: number; readonly steps: number }
  | {
      readonly status: "failed";
      readonly seed: number;
      /** 1-based run that found the failure. */
      readonly run: number;
      readonly found: readonly PlannedStep[];
      readonly shrunk: readonly PlannedStep[];
      readonly failure: SequenceFailure;
      /** What each step of `shrunk` returned, the failed step's included. */
      readonly outcomes: readonly StepOutcome[];
      readonly shrinkAttempts: number;
    }
  | { readonly status: "model-error"; readonly seed: number; readonly run: number; readonly message: string };

interface PlannedWithState extends PlannedStep {
  readonly state: unknown;
}

interface Plan {
  readonly steps: readonly PlannedWithState[];
  /** `[start, end)` of each step's choices in `choices`. */
  readonly spans: readonly (readonly [number, number])[];
  readonly choices: readonly number[];
}

class ModelCallbackError extends Error {}

function callModel<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new ModelCallbackError(`${what} threw: ${describeError(error)}`);
  }
}

function plan(model: Model, source: ChoiceSource, length: number): Plan {
  const names = Object.keys(model.commands);
  const draw = drawFrom(source);
  const steps: PlannedWithState[] = [];
  const spans: (readonly [number, number])[] = [];
  let state = callModel("initial", () => model.initial());
  while (steps.length < length && !source.exhausted()) {
    const current = state;
    const enabled = names.filter((name) =>
      callModel(`pre of command "${name}"`, () => model.commands[name]!.pre(current)),
    );
    if (enabled.length === 0) break;
    const start = source.used.length;
    const name = enabled[source.choose(enabled.length)]!;
    const command = model.commands[name]!;
    const args = callModel(`args of command "${name}"`, () => command.args(current, draw));
    state = callModel(`next of command "${name}"`, () => command.next(current, args));
    steps.push({ name, args, state: current });
    spans.push([start, source.used.length]);
  }
  return { steps, spans, choices: [...source.used] };
}

/** The plan up to and including the step that failed: what came after it
 * never ran, so it is not part of the failure. */
function cutAt(failing: Plan, index: number): Plan {
  return {
    steps: failing.steps.slice(0, index + 1),
    spans: failing.spans.slice(0, index + 1),
    choices: failing.choices.slice(0, failing.spans[index]![1]),
  };
}

interface Executed {
  readonly failure: SequenceFailure | undefined;
  readonly outcomes: readonly StepOutcome[];
}

async function execute(model: Model, planned: Plan, open: OpenSequence): Promise<Executed> {
  const session = await open();
  const outcomes: StepOutcome[] = [];
  let passed = false;
  try {
    const failure = await runSteps(model, planned, session, outcomes);
    passed = failure === undefined;
    return { failure, outcomes };
  } finally {
    await session.close(passed ? "passed" : "failed");
  }
}

async function runSteps(
  model: Model,
  planned: Plan,
  session: SequenceSession,
  outcomes: StepOutcome[],
): Promise<SequenceFailure | undefined> {
  for (const [index, step] of planned.steps.entries()) {
    const outcome = await session.run(step.name, step.args);
    outcomes.push(outcome);
    const command = step.name;
    if (!outcome.ok) return { index, kind: "step", command, message: outcome.message };
    let holds: boolean;
    try {
      holds = model.commands[command]!.post(step.state, step.args, outcome.result);
    } catch (error) {
      return { index, kind: "post-threw", command, message: `post of command "${command}" threw: ${describeError(error)}` };
    }
    if (!holds) {
      return {
        index,
        kind: "post-false",
        command,
        message: `post of command "${command}" returned false for result ${JSON.stringify(outcome.result)}`,
      };
    }
  }
  return undefined;
}

/** Shortlex: fewer choices first, then the smaller choice at the first
 * difference. */
function simpler(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return a.length < b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return false;
}

/** The message is not compared. It carries the result and the args, and
 * those are what shrinking changes: a duplicate add shrunk from 3 to 2
 * still fails the same post, with a different number in its message. */
function sameFailure(a: SequenceFailure, b: SequenceFailure): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "step" || a.command === b.command;
}

function lowered(value: number): number[] {
  if (value === 0) return [];
  return [...new Set([0, Math.floor(value / 2), value - 1])];
}

interface Failing {
  readonly plan: Plan;
  readonly failure: SequenceFailure;
  readonly outcomes: readonly StepOutcome[];
}

async function shrink(
  options: ExploreModelOptions,
  first: Failing,
): Promise<{ readonly best: Failing; readonly attempts: number }> {
  const limit = options.maxShrinkAttempts ?? DEFAULT_MAX_SHRINK_ATTEMPTS;
  let best = first;
  let attempts = 0;

  async function attempt(choices: readonly number[]): Promise<boolean> {
    attempts += 1;
    let candidate: Plan;
    try {
      candidate = plan(options.model, replayedSource(choices), options.length);
    } catch (error) {
      if (error instanceof ModelCallbackError) return false;
      throw error;
    }
    const { failure, outcomes } = await execute(options.model, candidate, options.open);
    if (failure === undefined || !sameFailure(failure, best.failure)) return false;
    const cut = cutAt(candidate, failure.index);
    if (!simpler(cut.choices, best.plan.choices)) return false;
    best = { plan: cut, failure, outcomes };
    return true;
  }

  let improved = true;
  while (improved && attempts < limit) {
    improved = false;
    const { spans, choices } = best.plan;
    for (const [start, end] of spans) {
      if (attempts >= limit) break;
      if (await attempt([...choices.slice(0, start), ...choices.slice(end)])) {
        improved = true;
        break;
      }
    }
    if (improved) continue;
    outer: for (const [position, value] of choices.entries()) {
      for (const candidate of lowered(value)) {
        if (attempts >= limit) break outer;
        const edited = [...choices];
        edited[position] = candidate;
        if (await attempt(edited)) {
          improved = true;
          break outer;
        }
      }
    }
  }
  return { best, attempts };
}

function withoutState(steps: readonly PlannedWithState[]): PlannedStep[] {
  return steps.map(({ name, args }) => ({ name, args }));
}

export async function exploreModel(options: ExploreModelOptions): Promise<ExploreModelResult> {
  const { model, seed, runs, length, open } = options;
  const next = seededUint32(seed);
  let steps = 0;
  for (let run = 1; run <= runs; run++) {
    let planned: Plan;
    try {
      planned = plan(model, generatedSource(next), length);
    } catch (error) {
      if (error instanceof ModelCallbackError) {
        return { status: "model-error", seed, run, message: error.message };
      }
      throw error;
    }
    const { failure, outcomes } = await execute(model, planned, open);
    if (failure === undefined) {
      steps += planned.steps.length;
      continue;
    }
    const found = cutAt(planned, failure.index);
    const { best, attempts } = await shrink(options, { plan: found, failure, outcomes });
    return {
      status: "failed",
      seed,
      run,
      found: withoutState(found.steps),
      shrunk: withoutState(best.plan.steps),
      failure: best.failure,
      outcomes: best.outcomes,
      shrinkAttempts: attempts,
    };
  }
  return { status: "passed", seed, runs, steps };
}
