// Responsibility: the compat module's registration buffers — the mechanism
// docs/spec.md's migration-door promise runs on. `Given`/`When`/`Then`/
// `defineParameterType` are plain functions that push onto a module-level
// array, nothing else, so a step file's top-level call to them (made while
// discovery imports that file) is observable to discovery right afterward.
//
// Kept separate from compat/index.ts (the public "nukadoko/compat" surface)
// so src/discover/discover-steps.ts can import *this* file directly, by its
// own relative path, and land on the exact same module instance a step file
// reaches indirectly via "nukadoko/compat" -> ./registry.js: both
// resolutions produce the identical absolute file URL, and tsx's per-
// discovery-run namespace (register({ namespace }) in discover-steps.ts)
// caches a module by that resolved URL — so the two paths converge on one
// shared buffer for the whole discovery run (m2-design.md section 2: "compat
// モジュールインスタンスとバッファも discovery ごとに独立", a module-identity
// consequence already relied on for typed steps — see discover-steps.ts's own
// header). tests/compat-discover.test.ts's concurrent-discovery test is what
// pins this down empirically: two `discoverSteps()` calls each get their own
// tsx namespace and therefore their own instance of this module, so
// registering the exact same pattern text "at the same time" in both never
// cross-contaminates either one's buffer.
//
// compat is the migration door (docs/spec.md "Compat steps"): a compat asset
// that works today must not stop working. This module's whole job is to
// record what was called, faithfully, and nothing more — it does no
// validation of its own beyond the shape of its own arguments; duplicate-
// pattern and parameter-type-collision detection both happen downstream
// (src/discover/discover-steps.ts, src/binding/registry.ts) where the full
// vocabulary/config picture is available.

export type CompatKeyword = "Given" | "When" | "Then";
export type CompatPattern = string | RegExp;

/** A compat glue function's signature (cucumber-js's own commonly used
 * shape): called with `this` bound to the World and the matched values as
 * positional arguments. Execution (actually calling `fn`) is M2's slice B —
 * this module only ever stores it. `...args: any[]`, not `unknown[]`, on
 * purpose: a pattern's captures determine each argument's real type (e.g. a
 * `{string}` capture wants a `(name: string) => ...` glue function), which
 * this module can't know statically — `unknown[]` would make TypeScript's
 * contravariant parameter check reject every realistically-typed glue
 * function, the same reason `@cucumber/cucumber`'s own upstream typings use
 * `any` here too. */
export type CompatStepFn = (this: any, ...args: any[]) => unknown;

export interface CompatStepRegistration {
  readonly keyword: CompatKeyword;
  readonly pattern: CompatPattern;
  readonly fn: CompatStepFn;
  readonly registrationOrder: number;
}

/** Same shape a `config.parameterTypes` entry takes (parameter-types-
 * design.md's "gradual compat" section) — `regexp`/`transformer` are handed
 * to `@cucumber/cucumber-expressions`' own `ParameterType` almost verbatim,
 * same as the config-origin path (src/binding/registry.ts). */
export interface CompatParameterTypeOptions {
  readonly name: string;
  readonly regexp: RegExp | string;
  readonly transformer?: (...match: string[]) => unknown;
}

export interface CompatParameterTypeRegistration extends CompatParameterTypeOptions {
  readonly registrationOrder: number;
}

let stepBuffer: CompatStepRegistration[] = [];
let parameterTypeBuffer: CompatParameterTypeRegistration[] = [];
let registrationCounter = 0;

function registerStep(keyword: CompatKeyword, pattern: CompatPattern, fn: CompatStepFn): void {
  stepBuffer.push({ keyword, pattern, fn, registrationOrder: registrationCounter++ });
}

/**
 * `Given`/`When`/`Then` are the exact same registration function under three
 * names (m2a-compat-registry task spec, decision 1; cucumber-js itself works
 * the same way) — the keyword carries no matching meaning at registration
 * time. Only Gherkin's own pickle compilation later gives a step *text* an
 * Action/Outcome position (docs/spec.md "Keyword semantics": "Gherkin
 * classifies an And/But step by inheriting the pickle step type of the
 * preceding primary keyword" — a nukadoko/gherkin behavior, not something
 * this registration API decides).
 */
export const Given: (pattern: CompatPattern, fn: CompatStepFn) => void = (pattern, fn) =>
  registerStep("Given", pattern, fn);
export const When: (pattern: CompatPattern, fn: CompatStepFn) => void = (pattern, fn) =>
  registerStep("When", pattern, fn);
export const Then: (pattern: CompatPattern, fn: CompatStepFn) => void = (pattern, fn) =>
  registerStep("Then", pattern, fn);

/**
 * Registers a custom cucumber-expressions parameter type from compat
 * ("support") code. Layered into the *same* `ParameterTypeRegistry` as
 * config-origin entries by src/binding/registry.ts, not a registry of its
 * own — a name collision between the two sources is caught there exactly
 * like a collision between two config entries, and moving a registration
 * from here to config later changes nothing about what any pattern matches
 * (parameter-types-design.md's "gradual compat" section, point 3).
 */
export function defineParameterType(options: CompatParameterTypeOptions): void {
  parameterTypeBuffer.push({ ...options, registrationOrder: registrationCounter++ });
}

/**
 * Returns every step registered since the last drain and empties the
 * buffer. src/discover/discover-steps.ts calls this once per step file,
 * immediately after importing it — nothing else runs between one file's
 * import and its own drain call, so whatever this returns is exactly (and
 * only) that file's own top-level registrations.
 */
export function drainCompatSteps(): CompatStepRegistration[] {
  const drained = stepBuffer;
  stepBuffer = [];
  return drained;
}

/** Same contract as `drainCompatSteps`, for `defineParameterType`. */
export function drainCompatParameterTypes(): CompatParameterTypeRegistration[] {
  const drained = parameterTypeBuffer;
  parameterTypeBuffer = [];
  return drained;
}
