import type { z } from "zod";
import type { Step } from "./define-step.js";

// Responsibility: the `defineModel` and `defineRelation` declarations.
// Discovery recognizes them the same way it recognizes a `Step`: a brand
// that survives discovery's separate module graph (`Symbol.for`, same reason as
// src/step/brand.ts). This file stores the functions a later run will call.
// It does not call them, and it does not look at the vocabulary. Whether a
// named step exists, and whether that step needs a browser, is
// src/check/explore-check.ts, which can be wrong only by reading the
// declaration, never by running it.

/** Process-wide brand. A plain Symbol would not match across the graph that
 * loads a model file and the graph that loads this module. */
export const MODEL_BRAND: unique symbol = Symbol.for("nukadoko.model");
export const RELATION_BRAND: unique symbol = Symbol.for("nukadoko.relation");

type ArgsOf<S extends Step> = z.infer<S["args"]>;
type ResultOf<S extends Step> = z.infer<S["returns"]>;

/** The one source of variation a model's `args` gets. Each call is one
 * recorded choice, so `nuka explore` can replay and shrink a sequence. A
 * lower choice is a smaller `int` or an earlier item of `pick`. */
export interface Draw {
  /** A whole number from `min` to `max`, both included. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

/** One command in a model. `step` carries the args and result types. The
 * record key is the step's basename, the name discovery gives the file.
 * `post` sees the validated result. `next` sees the model and the args
 * only, so a model update cannot depend on a result field the step did not
 * declare. */
export interface ModelCommand<TState, S extends Step> {
  readonly step: S;
  args: (state: TState, draw: Draw) => ArgsOf<S>;
  pre: (state: TState) => boolean;
  next: (state: TState, args: ArgsOf<S>) => TState;
  post: (state: TState, args: ArgsOf<S>, result: ResultOf<S>) => boolean;
}

export interface Model {
  readonly [MODEL_BRAND]: true;
  readonly initial: () => unknown;
  readonly commands: Readonly<
    Record<
      string,
      {
        readonly step: Step;
        args: (state: unknown, draw: Draw) => unknown;
        pre: (state: unknown) => boolean;
        next: (state: unknown, args: unknown) => unknown;
        post: (state: unknown, args: unknown, result: unknown) => boolean;
      }
    >
  >;
}

/**
 * Binds one command to one step. Call it as `modelCommand(step)({ ... })`
 * inside `defineModel(initial).commands({ ... })` so the model state reaches
 * the callbacks, and the step's args and result stay on this command.
 * A single object literal widens `step` to `Step` before those callbacks
 * are checked.
 */
export function modelCommand<S extends Step>(step: S) {
  return <TState>(body: {
    args: (state: TState, draw: Draw) => ArgsOf<S>;
    pre: (state: TState) => boolean;
    next: (state: TState, args: ArgsOf<S>) => TState;
    post: (state: TState, args: ArgsOf<S>, result: ResultOf<S>) => boolean;
  }): ModelCommand<TState, S> => ({ step, ...body });
}

/**
 * `initial` fixes the model state. `commands` then checks each basename's
 * command against that state. The two calls exist so the state type is
 * known before the command callbacks are checked.
 */
export function defineModel<TState>(initial: () => TState) {
  return {
    commands(commands: { readonly [name: string]: ModelCommand<TState, any> }): Model {
      return {
        [MODEL_BRAND]: true,
        initial: initial as () => unknown,
        commands: commands as Model["commands"],
      };
    },
  };
}

export function isModel(value: unknown): value is Model {
  return (
    typeof value === "object" &&
    value !== null &&
    MODEL_BRAND in value &&
    (value as Record<PropertyKey, unknown>)[MODEL_BRAND] === true
  );
}

/** One step in a relation sequence. `step` is the vocabulary step, so
 * `args` is that step's args and the result of running it is that step's
 * returns. */
export interface RelationStep<S extends Step = Step> {
  readonly step: S;
  readonly args: ArgsOf<S>;
}

type ResultsOf<T extends readonly RelationStep[]> = {
  [I in keyof T]: T[I] extends RelationStep<infer S> ? ResultOf<S> : never;
};

/** A source `nuka explore` generates from `draw`, at most `length` steps
 * long. Every value that varies comes from `draw`, so the source replays
 * from a seed and shrinks. */
export type SourceDraw<S extends Step = Step> = (draw: Draw, length: number) => readonly RelationStep<S>[];

/** A declared sequence, a model whose commands generate the sequence (its
 * `post` is not called), or a function of `draw`. */
export type RelationSource = readonly RelationStep[] | Model | SourceDraw;

export interface Relation {
  readonly [RELATION_BRAND]: true;
  readonly name: string;
  readonly source: RelationSource;
  readonly follow: (source: readonly RelationStep[]) => readonly RelationStep[];
  readonly relate: (sourceResults: readonly unknown[], followResults: readonly unknown[]) => boolean;
}

/** One `{ step, args }` entry whose `args` are checked against `step`.
 * Same inference reason as `modelCommand`: the step has to be an argument
 * of its own, or `args` widens to `unknown` before the check runs. */
export function relationEntry<S extends Step>(step: S, args: ArgsOf<S>): RelationStep<S> {
  return { step, args };
}

/**
 * A relation names one source sequence, a `follow` that returns the second
 * sequence, and `relate` over the two runs' results. `follow` is not a
 * second copy of the system: check stores it and a later run is what calls
 * it. `relate` receives results only, so its type has no `Step` to call.
 *
 * `source` is either the declared sequence, or one `nuka explore`
 * generates: a function of `draw` and the most steps it may return, or a
 * model whose `pre`, `args`, and `next` pick the steps. A generated source
 * is shrunk when the relation fails.
 */
export function defineRelation<
  const TSource extends readonly RelationStep[],
  const TFollow extends readonly RelationStep[],
>(definition: {
  readonly name: string;
  readonly source: TSource;
  follow: (source: TSource) => TFollow;
  relate: (sourceResults: ResultsOf<TSource>, followResults: ResultsOf<TFollow>) => boolean;
}): Relation;
export function defineRelation<S extends Step, const TFollow extends readonly RelationStep[]>(definition: {
  readonly name: string;
  readonly source: SourceDraw<S>;
  follow: (source: readonly RelationStep<S>[]) => TFollow;
  relate: (sourceResults: readonly ResultOf<S>[], followResults: ResultsOf<TFollow>) => boolean;
}): Relation;
export function defineRelation<const TFollow extends readonly RelationStep[]>(definition: {
  readonly name: string;
  readonly source: Model;
  follow: (source: readonly RelationStep[]) => TFollow;
  relate: (sourceResults: readonly unknown[], followResults: ResultsOf<TFollow>) => boolean;
}): Relation;
export function defineRelation(definition: {
  readonly name: string;
  readonly source: RelationSource;
  follow: (source: never) => readonly RelationStep[];
  relate: (sourceResults: never, followResults: never) => boolean;
}): Relation {
  return {
    [RELATION_BRAND]: true,
    name: definition.name,
    source: definition.source,
    follow: definition.follow as unknown as Relation["follow"],
    relate: definition.relate as unknown as Relation["relate"],
  };
}

export function isRelation(value: unknown): value is Relation {
  return (
    typeof value === "object" &&
    value !== null &&
    RELATION_BRAND in value &&
    (value as Record<PropertyKey, unknown>)[RELATION_BRAND] === true
  );
}
