import type { Relation, RelationStep } from "../step/define-explore.js";
import type { Step } from "../step/define-step.js";
import { describeError, type OpenSequence, type PlannedStep, type StepOutcome } from "./sequence.js";

// Responsibility: run a relation once. The source sequence runs in one
// world, `follow` names the second sequence, that one runs in a fresh
// world, and `relate` compares the two lists of results. A failed step in
// either sequence, or a `relate` that does not hold, fails the relation,
// and both sequences are returned so the caller can print both scenarios.
// The source is the declared one: this file does not generate or shrink.

export interface ExploreRelationOptions {
  readonly relation: Relation;
  /** The vocabulary name of a step, or why the step cannot run here. The
   * source was checked by `nuka check`. The second sequence only exists
   * once `follow` returns, so its steps are judged here. */
  readonly resolve: (step: Step) => { readonly name: string } | { readonly error: string };
  readonly open: OpenSequence;
}

export type RelationFailure =
  | { readonly sequence: "source" | "follow"; readonly index: number; readonly message: string }
  | { readonly sequence: "relate"; readonly message: string };

export type ExploreRelationResult =
  | { readonly status: "passed"; readonly source: readonly PlannedStep[]; readonly follow: readonly PlannedStep[] }
  | {
      readonly status: "failed";
      readonly source: readonly PlannedStep[];
      readonly follow: readonly PlannedStep[];
      readonly failure: RelationFailure;
      /** One per step that ran, in order. A sequence after a failed one
       * did not run, so its list is empty. */
      readonly sourceOutcomes: readonly StepOutcome[];
      readonly followOutcomes: readonly StepOutcome[];
    }
  | { readonly status: "relation-error"; readonly message: string };

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
  const { relation, resolve, open } = options;
  let followEntries: readonly RelationStep[];
  try {
    followEntries = relation.follow(relation.source);
  } catch (error) {
    return { status: "relation-error", message: `follow threw: ${describeError(error)}` };
  }
  const source = name(relation.source, resolve, "source");
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
    return { status: "failed", ...both, failure: { sequence: "relate", message: `relate threw: ${describeError(error)}` }, ...ran };
  }
  if (!holds) {
    return {
      status: "failed",
      ...both,
      ...ran,
      failure: {
        sequence: "relate",
        message:
          `relate returned false for source results ${JSON.stringify(sourceRun.results)} ` +
          `and follow results ${JSON.stringify(followRun.results)}`,
      },
    };
  }
  return { status: "passed", ...both };
}
