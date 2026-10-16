import { isModel, type Model, type Relation, type RelationStep, type SourceDraw } from "../step/define-explore.js";
import type { Step } from "../step/define-step.js";
import { drawFrom, generatedSource, replayedSource, seededUint32, type ChoiceSource } from "./choices.js";
import { callModel, ModelCallbackError, plan } from "./explore-model.js";
import { describeError, type OpenSequence, type PlannedStep, type StepOutcome } from "./sequence.js";
import { shrinkChoices, type Shrinkable } from "./shrink.js";

// Responsibility: run a relation. One run runs the source sequence in one
// world, calls `follow` for the second sequence, runs that one in a fresh
// world, and calls `relate` on the two lists of results. A failed step in
// either sequence, or a `relate` that does not hold, fails the relation,
// and both sequences are returned so the caller can print both scenarios.
//
// A declared source runs once. A generated source (a function of `draw`,
// or a model's commands) runs `runs` times from one seed, and the first
// failure is shrunk the way a model's is (shrink.ts). An edit is kept only
// when the relation still fails the same way (`sameFailure`): a source
// that breaks `relate` is not traded for one whose own step fails.

export interface ExploreRelationOptions {
  readonly relation: Relation;
  /** The vocabulary name of a step, or why the step cannot run here. The
   * source was checked by `nuka check`. The second sequence only exists
   * once `follow` returns, so its steps are judged here. */
  readonly resolve: (step: Step) => { readonly name: string } | { readonly error: string };
  readonly open: OpenSequence;
  /** Used only by a generated source. */
  readonly seed?: number;
  readonly runs?: number;
  readonly length?: number;
  readonly maxShrinkAttempts?: number;
}

/** How a generated source was found and shrunk. */
export interface GeneratedRun {
  readonly seed: number;
  /** 1-based run that found the failure. */
  readonly run: number;
  /** Source steps of the sequence the run found, before shrinking. */
  readonly foundSteps: number;
  readonly shrinkAttempts: number;
}

export type RelationFailure =
  | { readonly sequence: "source" | "follow"; readonly index: number; readonly message: string }
  | { readonly sequence: "relate"; readonly threw: boolean; readonly message: string };

export type ExploreRelationResult =
  | { readonly status: "passed"; readonly source: readonly PlannedStep[]; readonly follow: readonly PlannedStep[] }
  | { readonly status: "passed"; readonly generated: { readonly seed: number; readonly runs: number } }
  | Unpassed;

type Unpassed =
  | {
      readonly status: "failed";
      readonly source: readonly PlannedStep[];
      readonly follow: readonly PlannedStep[];
      readonly failure: RelationFailure;
      /** One per step that ran, in order. A sequence after a failed one
       * did not run, so its list is empty. */
      readonly sourceOutcomes: readonly StepOutcome[];
      readonly followOutcomes: readonly StepOutcome[];
      readonly generated?: GeneratedRun;
    }
  | {
      readonly status: "relation-error";
      readonly message: string;
      readonly generated?: { readonly seed: number; readonly run: number };
    };

type Once =
  | { readonly status: "passed"; readonly source: readonly PlannedStep[]; readonly follow: readonly PlannedStep[] }
  | Unpassed;

type Named = { readonly ok: true; readonly steps: PlannedStep[] } | { readonly ok: false; readonly message: string };

function name(entries: readonly RelationStep[], resolve: ExploreRelationOptions["resolve"], label: string): Named {
  const steps: PlannedStep[] = [];
  for (const [index, entry] of entries.entries()) {
    const resolved = resolve(entry.step);
    if ("error" in resolved) {
      return { ok: false, message: `${label} step ${index + 1}: ${resolved.error}` };
    }
    steps.push({ name: resolved.name, args: entry.args });
  }
  return { ok: true, steps };
}

type Ran =
  | { readonly ok: true; readonly outcomes: readonly StepOutcome[]; readonly results: unknown[] }
  | { readonly ok: false; readonly outcomes: readonly StepOutcome[]; readonly index: number; readonly message: string };

async function runAll(steps: readonly PlannedStep[], open: OpenSequence): Promise<Ran> {
  const session = await open();
  const outcomes: StepOutcome[] = [];
  let passed = false;
  try {
    const results: unknown[] = [];
    for (const [index, step] of steps.entries()) {
      const outcome = await session.run(step.name, step.args);
      outcomes.push(outcome);
      if (!outcome.ok) return { ok: false, outcomes, index, message: outcome.message };
      results.push(outcome.result);
    }
    passed = true;
    return { ok: true, outcomes, results };
  } finally {
    await session.close(passed ? "passed" : "failed");
  }
}

export async function exploreRelation(options: ExploreRelationOptions): Promise<ExploreRelationResult> {
  const { source } = options.relation;
  if (Array.isArray(source)) return runOnce(options, source);
  return exploreGenerated(options, source as Model | SourceDraw);
}

async function runOnce(options: ExploreRelationOptions, sourceEntries: readonly RelationStep[]): Promise<Once> {
  const { relation, resolve, open } = options;
  let followEntries: readonly RelationStep[];
  try {
    followEntries = relation.follow(sourceEntries);
  } catch (error) {
    return { status: "relation-error", message: `follow threw: ${describeError(error)}` };
  }
  const source = name(sourceEntries, resolve, "source");
  if (!source.ok) return { status: "relation-error", message: source.message };
  const follow = name(followEntries, resolve, "follow");
  if (!follow.ok) return { status: "relation-error", message: follow.message };

  const both = { source: source.steps, follow: follow.steps };
  const sourceRun = await runAll(source.steps, open);
  if (!sourceRun.ok) {
    const { index, message, outcomes } = sourceRun;
    return { status: "failed", ...both, failure: { sequence: "source", index, message }, sourceOutcomes: outcomes, followOutcomes: [] };
  }
  const followRun = await runAll(follow.steps, open);
  const ran = { sourceOutcomes: sourceRun.outcomes, followOutcomes: followRun.outcomes };
  if (!followRun.ok) {
    return { status: "failed", ...both, failure: { sequence: "follow", index: followRun.index, message: followRun.message }, ...ran };
  }
  let holds: boolean;
  try {
    holds = relation.relate(sourceRun.results, followRun.results);
  } catch (error) {
    return { status: "failed", ...both, failure: { sequence: "relate", threw: true, message: `relate threw: ${describeError(error)}` }, ...ran };
  }
  if (!holds) {
    return {
      status: "failed",
      ...both,
      ...ran,
      failure: {
        sequence: "relate",
        threw: false,
        message:
          `relate returned false for source results ${JSON.stringify(sourceRun.results)} ` +
          `and follow results ${JSON.stringify(followRun.results)}`,
      },
    };
  }
  return { status: "passed", ...both };
}

interface Built extends Shrinkable {
  readonly entries: readonly RelationStep[];
}

/** Throws ModelCallbackError when a callback of the source throws, or a
 * `draw` source returns more steps than `length` allows. */
function build(source: Model | SourceDraw, choices: ChoiceSource, length: number): Built {
  if (isModel(source)) {
    const planned = plan(source, choices, length);
    return {
      entries: planned.steps.map((step) => ({ step: source.commands[step.name]!.step, args: step.args })),
      spans: planned.spans,
      choices: planned.choices,
    };
  }
  const entries = callModel("source", () => source(drawFrom(choices), length));
  if (entries.length > length) {
    throw new ModelCallbackError(`source returned ${entries.length} steps, more than the length ${length}`);
  }
  // The steps a draw function made are not known by choice, so each
  // choice is its own span.
  const used = [...choices.used];
  return { entries, spans: used.map((_, index) => [index, index + 1] as const), choices: used };
}

type Failed = Extract<Once, { status: "failed" }>;

/** The same sequence, and for `relate` the same way out: a `relate` that
 * throws on an empty source is not the `false` the run found. */
function sameFailure(a: RelationFailure, b: RelationFailure): boolean {
  if (a.sequence !== b.sequence) return false;
  return a.sequence !== "relate" || b.sequence !== "relate" || a.threw === b.threw;
}

interface Failing extends Built {
  readonly result: Failed;
}

async function exploreGenerated(options: ExploreRelationOptions, source: Model | SourceDraw): Promise<ExploreRelationResult> {
  const seed = options.seed ?? 0;
  const runs = options.runs ?? 1;
  const length = options.length ?? 1;
  const next = seededUint32(seed);
  for (let run = 1; run <= runs; run++) {
    let built: Built;
    try {
      built = build(source, generatedSource(next), length);
    } catch (error) {
      if (error instanceof ModelCallbackError) {
        return { status: "relation-error", message: error.message, generated: { seed, run } };
      }
      throw error;
    }
    const once = await runOnce(options, built.entries);
    if (once.status === "passed") continue;
    if (once.status === "relation-error") return { ...once, generated: { seed, run } };
    const { best, attempts } = await shrinkChoices<Failing>(
      { ...built, result: once },
      async (choices) => {
        let candidate: Built;
        try {
          candidate = build(source, replayedSource(choices), length);
        } catch (error) {
          if (error instanceof ModelCallbackError) return undefined;
          throw error;
        }
        const result = await runOnce(options, candidate.entries);
        if (result.status !== "failed" || !sameFailure(result.failure, once.failure)) return undefined;
        return { ...candidate, result };
      },
      options.maxShrinkAttempts,
    );
    return {
      ...best.result,
      generated: { seed, run, foundSteps: built.entries.length, shrinkAttempts: attempts },
    };
  }
  return { status: "passed", generated: { seed, runs } };
}
