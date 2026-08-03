import type { z } from "zod";
import type { StepContext } from "../context.js";
import { STEP_BRAND } from "./brand.js";

// Responsibility: the `defineStep` API from docs/spec.md "Typed steps", and
// the `Step` shape discovery recognizes. Does not execute anything (`run` is
// stored, never called here) and does not validate `args`/`returns` at the
// run boundary — that is the execution slice's job.

export interface StepDefinitionInput<
  TArgs extends z.ZodTypeAny = z.ZodTypeAny,
  TReturns extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** Binds the step to Gherkin text (cucumber-expressions syntax). */
  pattern?: string;
  /** Aliases for `pattern`. Either or both may be given; omit both for CLI-only vocabulary. */
  patterns?: string[];
  /** What this step does — the information an agent uses to pick which step
   * to call. Shown in `nuka steps`' one-line-per-step listing. */
  description: string;
  args: TArgs;
  returns: TReturns;
  /** Whether the step changes state anywhere it touches. Defaults to `true`. */
  mutates?: boolean;
  /** Why this is implemented this way, and what was tried and rejected — the
   * information an agent uses to judge whether it may rewrite this step.
   * Not shown in `nuka steps` (t2-rationale task spec, item 3: that listing
   * stays one-line-per-step); shown in `nuka describe`. No default — omit it
   * and `Step.rationale` is `undefined`, same as omitting `pattern`. */
  rationale?: string;
  run(
    ctx: StepContext,
    args: z.infer<TArgs>,
  ): Promise<z.infer<TReturns>> | z.infer<TReturns>;
}

export interface Step<
  TArgs extends z.ZodTypeAny = z.ZodTypeAny,
  TReturns extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly patterns: readonly string[];
  readonly description: string;
  readonly args: TArgs;
  readonly returns: TReturns;
  readonly mutates: boolean;
  readonly rationale: string | undefined;
  readonly run: (
    ctx: StepContext,
    args: z.infer<TArgs>,
  ) => Promise<z.infer<TReturns>> | z.infer<TReturns>;
  readonly [STEP_BRAND]: true;
}

/**
 * `pattern` and `patterns` are both optional aliases for the same list; when
 * both are given, `pattern` is treated as the first entry. Neither is
 * required — the spec allows a step to be CLI-only vocabulary.
 */
function resolvePatterns(definition: StepDefinitionInput): string[] {
  const fromPattern = definition.pattern ? [definition.pattern] : [];
  const fromPatterns = definition.patterns ?? [];
  return [...fromPattern, ...fromPatterns];
}

export function defineStep<
  TArgs extends z.ZodTypeAny,
  TReturns extends z.ZodTypeAny,
>(definition: StepDefinitionInput<TArgs, TReturns>): Step<TArgs, TReturns> {
  return {
    patterns: resolvePatterns(definition),
    description: definition.description,
    args: definition.args,
    returns: definition.returns,
    mutates: definition.mutates ?? true,
    rationale: definition.rationale,
    run: definition.run,
    [STEP_BRAND]: true,
  };
}

/**
 * True when `value` is a `Step` produced by `defineStep` — including one
 * produced in a different module realm (see brand.ts for why the brand
 * survives that boundary). Used by discovery to tell steps apart from other
 * default exports (shared helpers) without assuming anything about their
 * shape beyond the brand.
 */
export function isStep(value: unknown): value is Step {
  return (
    typeof value === "object" &&
    value !== null &&
    STEP_BRAND in value &&
    (value as Record<PropertyKey, unknown>)[STEP_BRAND] === true
  );
}
