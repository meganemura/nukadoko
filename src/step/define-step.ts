import type { z } from "zod";
import type { StepContext } from "../context.js";
import { STEP_BRAND } from "./brand.js";

// Responsibility: the `defineStep` API from docs/spec.md "Typed steps", and
// the `Step` shape discovery recognizes. Does not execute anything (`run` is
// stored, never called here) and does not validate `args`/`returns` at the
// run boundary — that is the execution slice's job. `from`'s own runtime
// validation (m6a-from-core task spec, item 3) lives in
// src/step/validate-from.ts, not here, for the same reason this file never
// validates `args`/`returns` itself: this module only shapes a declaration,
// it never checks one against a live vocabulary.
//
// `from` (m6a-from-core task spec; docs/spec.md "Typed steps"/"Chaining
// steps") declares where an args key's value comes from when a pickle line
// doesn't capture it: `{ projectId: [createProject, "id"] }` reads as
// "`projectId` is the `id` of whatever `createProject` returned earlier in
// this scenario". A key name, never a transform or a selector function
// (docs/spec.md "Chaining steps" explains why that limit is the point) — and
// exactly because it's a key name, part of it is checkable in the type
// system: `FromMap` below constrains, per key, (1) that the key is one of
// `args`' own keys, (2) that the tuple's second element is one of the
// upstream step's `returns` keys, and (3) that the upstream value's type is
// assignable to the args key's type. It stops there on purpose (m6a-from-core
// task spec, item 2: don't burn time turning this into a type puzzle) — an
// upstream `returns` that isn't itself an object schema, or one this file's
// own inference can't pin down precisely, is left unconstrained rather than
// forced into a contorted type; src/step/validate-from.ts's runtime check is
// what actually enforces all three for every case the type layer can't, and
// is the one line of defense against a step author lying to the type checker
// with an `as` cast.
//
// A key may instead list several mutually exclusive producers (m7a-from-
// alternatives task spec, item 1; docs/spec.md "Chaining steps": "A key may
// name more than one possible producer"): `{ projectId: [[createProject,
// "id"], [importProject, "projectId"]] }`. Discriminated from the single-
// candidate form by the tuple's own first element — a `Step` means "this is
// one candidate", an array means "this is the list" — never by a wrapper
// type, so the single form written before this task keeps compiling and
// keeps meaning exactly what it meant (backward compatible on purpose: no
// existing `from: { key: [step, "key"] }` needs rewriting). The three checks
// above apply per candidate; there is deliberately no fourth check that
// picks a "best" or "first" candidate — which one actually supplies the
// value at run time is a per-scenario fact `src/check/from-order.ts` and
// `src/run/run-scenario.ts` judge, never this file (docs/spec.md "Chaining
// steps": "What this deliberately does not introduce is a priority").

/** A zod object schema's own key→schema shape; `{}` when `T` isn't one. This
 * task's spec, item 2's own scope note: `from`'s three checks only make
 * sense against an object — a step whose `args`, or whose upstream's
 * `returns`, is some other schema shape (a bare `z.string()`, a union, ...)
 * has no keys for `from` to be checked against at all, so this collapses to
 * "no keys" rather than a compile error that would fire on every such step
 * whether or not it even declares `from`. */
type ObjectShapeOf<T extends z.ZodTypeAny> = T extends z.ZodObject<infer Shape>
  ? Shape
  : Record<string, never>;

/** The keys of object shape `Shape` whose own value type is assignable to
 * `V` — bullet 3 of `from`'s three checks (this task's spec, item 2),
 * applied to whichever upstream `returns` shape `ValidatedFromEntry` below
 * resolves for a given entry. `z.infer` itself is unconstrained (zod 4's own
 * `core.output<T>` falls back to `unknown` for a `T` it doesn't recognize
 * as a schema, rather than requiring one), so this deliberately doesn't
 * constrain `Shape`'s own values either — zod's own object shape values are
 * zod 4's internal `$ZodType`, not the classic `z.ZodType` this file's other
 * signatures use, and requiring the classic type here would reject every
 * real shape zod itself produces. */
type KeysAssignableTo<Shape, V> = {
  [K in keyof Shape]: z.infer<Shape[K]> extends V ? K : never;
}[keyof Shape];

/**
 * Validates one candidate producer tuple (`[Step, string]`) against args key
 * `K`'s own declared value type — the same three-bullet check `from` has
 * always applied to its single-candidate form, factored out so it can run
 * once per candidate when a key lists several (m7a-from-alternatives task
 * spec, item 1). Self-referential on purpose — `S` (the upstream `Step`) and
 * its own `returns` shape are inferred fresh per candidate, so two different
 * candidates (whether on the same key or different keys) can each name a
 * different upstream step without their types interfering. Collapses to
 * `never` on failure, exactly like `ValidatedFromEntry` used to do directly.
 */
type ValidatedCandidate<Candidate, ArgsValueType> = Candidate extends readonly [
  infer S extends Step,
  infer UpstreamKey,
]
  ? S extends Step<z.ZodTypeAny, infer TReturns extends z.ZodTypeAny>
    ? UpstreamKey extends KeysAssignableTo<ObjectShapeOf<TReturns>, ArgsValueType>
      ? Candidate
      : never
    : never
  : never;

/**
 * `true` only when every candidate tuple in `Candidates` (a tuple of
 * tuples — the multi-candidate array TypeScript infers for `[[stepA, "k1"],
 * [stepB, "k2"]]`) individually validates against `ArgsValueType`
 * (`ValidatedCandidate` above). Recursive rather than a mapped-type-then-
 * compare pass, so one invalid candidate anywhere in the list fails the
 * whole entry directly — no candidate is allowed to "cover for" another
 * (m7a-from-alternatives task spec: the "no priority" rule has a type-level
 * corollary too — every listed candidate must independently type-check;
 * there is no "the first one that does wins"). Tuples this short (a `from`
 * key naming more than a handful of alternatives would already be a design
 * smell) never approach TypeScript's recursion limit.
 */
type AllCandidatesValid<Candidates extends readonly unknown[], ArgsValueType> = Candidates extends readonly [
  infer Head,
  ...infer Tail,
]
  ? ValidatedCandidate<Head, ArgsValueType> extends never
    ? false
    : AllCandidatesValid<Tail, ArgsValueType>
  : true;

/**
 * Validates one `from` entry (`TFrom[K]`, the literal TypeScript sees at
 * this exact key in the object literal a `defineStep` caller wrote) against
 * args key `K`'s own declared type — either the pre-m7a single-candidate
 * tuple, or an array of candidates (m7a-from-alternatives task spec, item 1).
 * Discriminated the same way the runtime does (this file's own header, and
 * src/step/define-step.ts's `fromCandidates`): the tuple's first element
 * being a `Step` (never an array — a `Step` is a plain object) means "this
 * is one candidate"; an array means "this is the list". An entry that fails
 * validation collapses to `never`, which the literal the caller actually
 * wrote is never assignable to — surfacing as a compile error at that key,
 * plain rather than maximally friendly; a readable message for each
 * candidate's own failure is what src/step/validate-from.ts's runtime check
 * gives instead.
 */
type ValidatedFromEntry<TFrom, K extends keyof TFrom, ArgsShape> = K extends keyof ArgsShape
  ? TFrom[K] extends readonly [infer S extends Step, unknown]
    ? ValidatedCandidate<TFrom[K], z.infer<ArgsShape[K]>>
    : TFrom[K] extends readonly (readonly [Step, unknown])[]
      ? AllCandidatesValid<TFrom[K], z.infer<ArgsShape[K]>> extends true
        ? TFrom[K]
        : never
      : never
  : never;

/** The constraint `defineStep`'s own `TFrom` type parameter is checked
 * against, key by key (`ValidatedFromEntry` above) — `Record<string, never>`
 * is both the default (no `from` declared at all) and what an entry with an
 * invalid key collapses to, so a `from` object with an extra, non-`args` key
 * is rejected the same way an invalid tuple is. */
export type FromMap<TFrom, TArgs extends z.ZodTypeAny> = {
  [K in keyof TFrom]: ValidatedFromEntry<TFrom, K, ObjectShapeOf<TArgs>>;
};

/** One candidate producer for a `from` key: the upstream `Step` and which of
 * its `returns` keys to read. Exported so every module reading `Step.from`
 * shares this one tuple shape (`readonly [Step, string]`) instead of each
 * re-declaring it — src/step/validate-from.ts, src/check/from-order.ts,
 * src/run/run-scenario.ts's `injectFrom`, src/cli/resolve-use.ts, and
 * src/cli/vocabulary.ts's rendering. */
export type FromCandidate = readonly [step: Step, key: string];

/** The runtime shape every `Step.from` actually has, regardless of which
 * `TFrom` a particular `defineStep` call validated against — deliberately
 * looser than `FromMap` above (that type only exists to validate the
 * literal a step author wrote; nothing downstream of `defineStep` needs to
 * know the specific upstream `Step`/key types of each entry, only that each
 * is *some* upstream `Step` paired with *some* key name). A key's own value
 * is either one candidate (the pre-m7a shape, kept so an existing `from: {
 * key: [step, "key"] }` declaration never needs rewriting) or an array of
 * them (m7a-from-alternatives task spec, item 1: mutually exclusive
 * producers, docs/spec.md "Chaining steps") — `fromCandidates` below is how
 * every consumer reads either shape uniformly instead of re-deriving which
 * one a given entry is. Consumers (src/run/run-scenario.ts's injection,
 * src/step/validate-from.ts's runtime check, src/check/from-order.ts,
 * src/cli/resolve-use.ts, src/cli/vocabulary.ts's `nuka steps --json`/`nuka
 * describe`) all read this shape. */
export type StepFromMap = Readonly<Record<string, FromCandidate | readonly FromCandidate[]>>;

/**
 * Normalizes one `Step.from` entry to its full candidate list (m7a-from-
 * alternatives task spec, item 1: "内部表現は正規化して構わない") — a single
 * `[Step, string]` tuple becomes a one-element array; an already-multi
 * `readonly [Step, string][]` passes through unchanged. The discriminator is
 * the entry's own first element: a `Step` (always a plain object, never an
 * array — `isStep`'s own brand check below) means "this is one candidate
 * tuple itself"; an array means "this is already the candidate list"
 * (docs/spec.md "Chaining steps": "A key may name more than one possible
 * producer", and this task's spec, item 1: "タプルの第 1 要素が Step か配列
 * かで判別できる"). Every reader of `Step.from` calls this once per key
 * instead of re-deriving the discriminator itself, so "single vs multi"
 * stays decided in exactly one place.
 */
export function fromCandidates(entry: FromCandidate | readonly FromCandidate[]): readonly FromCandidate[] {
  return Array.isArray(entry[0]) ? (entry as readonly FromCandidate[]) : [entry as FromCandidate];
}

export interface StepDefinitionInput<
  TArgs extends z.ZodTypeAny = z.ZodTypeAny,
  TReturns extends z.ZodTypeAny = z.ZodTypeAny,
  TFrom extends FromMap<TFrom, TArgs> = Record<string, never>,
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
  /** Where an args key's value comes from when a pickle line doesn't capture
   * it (m6a-from-core task spec; docs/spec.md "Chaining steps") — omit it
   * entirely, or omit any key of it, for a step that only ever takes that key
   * from the pattern/table/docstring. See this file's own header for what the
   * type system checks here versus what src/step/validate-from.ts's runtime
   * check backs it up with. */
  from?: TFrom;
  /** Why this is implemented this way, and what was tried and rejected — the
   * information an agent uses to judge whether it may rewrite the step.
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
  /** Empty (`{}`) when the step declares no `from` at all — the same
   * "default fills the gap" convention `mutates`'s own `?? true` follows,
   * rather than `undefined` (m6a-from-core task spec, item 1: `Step` always
   * has a `from`, never an optional one, so every reader can iterate it
   * unconditionally). */
  readonly from: StepFromMap;
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
 *
 * Typed against a `Pick`, not the bare `StepDefinitionInput` (all three type
 * parameters defaulted), on purpose: `from`'s own type parameter (`TFrom`)
 * makes the full interface's variance depend on it, so a caller passing a
 * `StepDefinitionInput<TArgs, TReturns, TFrom>` whose `TFrom` isn't exactly
 * the default `Record<string, never>` would otherwise fail to satisfy this
 * parameter's type even though this function never looks at `from`,
 * `args`, `returns`, or anything else generic at all.
 */
function resolvePatterns(definition: Pick<StepDefinitionInput, "pattern" | "patterns">): string[] {
  const fromPattern = definition.pattern ? [definition.pattern] : [];
  const fromPatterns = definition.patterns ?? [];
  return [...fromPattern, ...fromPatterns];
}

export function defineStep<
  TArgs extends z.ZodTypeAny,
  TReturns extends z.ZodTypeAny,
  const TFrom extends FromMap<TFrom, TArgs> = Record<string, never>,
>(definition: StepDefinitionInput<TArgs, TReturns, TFrom>): Step<TArgs, TReturns> {
  return {
    patterns: resolvePatterns(definition),
    description: definition.description,
    args: definition.args,
    returns: definition.returns,
    mutates: definition.mutates ?? true,
    // Cast is the one place `TFrom`'s validated-literal type (checked against
    // this exact step's `args`) gets widened to `Step.from`'s own loose,
    // uniform runtime shape (`StepFromMap`, this file's own header) — safe
    // because `FromMap`'s validation already guarantees every entry actually
    // is a `readonly [Step, string]` tuple; a rejected entry never compiles
    // to begin with.
    from: (definition.from ?? {}) as StepFromMap,
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
