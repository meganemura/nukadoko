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
// shared buffer for the whole discovery run (the compat module instance and
// its buffer are independent per discovery run too, a module-identity
// consequence already relied on for typed steps — see discover-steps.ts's
// own header).
// tests/compat-discover.test.ts's concurrent-discovery test is what
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
//
// `setDefaultTimeout`/`getDefaultTimeoutMs` (m22-compat-run-scope task spec,
// item 1) live here rather than in a module of their own: they need the
// exact same module-identity handoff to src/discover/discover-steps.ts's
// scoped tsx import that this file's own step buffer already has (see
// above), and discover-steps.ts already loads this module directly for that
// buffer — reusing that same load is simpler than adding a second scoped
// import just to reach one more value. Unlike `stepBuffer`, this is a single
// overwritable value, not a per-file buffer: see `setDefaultTimeout`'s own
// comment for why "last call wins" rather than "queued and drained".

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
  /** From the 3-argument form's `{ timeout }` (cucumber-js's own commonly
   * used shape: `Given(pattern, { timeout: 30_000 }, fn)`). Held here,
   * unenforced — this module only records what was called (see file header);
   * actually honoring a per-step timeout is m2b-compat-execution's job
   * (src/run/). Kept rather than silently dropped so a step whose author
   * wrote `{ timeout }` to bound a slow call doesn't quietly start running
   * unbounded — the exact "silent behavior change" this task's audit (m2.1-a
   * compat-audit synthesis, item 2) closes at the registration boundary;
   * slice B still owns whether it's ever actually applied. */
  readonly timeoutMs?: number;
  readonly registrationOrder: number;
}

/**
 * Options object accepted by the 3-argument step registration form —
 * `Given(pattern, options, fn)` (cucumber-js's own commonly used shape;
 * 194 real-world call sites across 3 repos per the m2.1-a compat-audit
 * synthesis, item 2). `timeout` is the only key this task's spec recognizes;
 * every other key throws at registration time rather than being silently
 * dropped (the audit's other closed case: an unrecognized option must not
 * quietly disappear).
 */
export interface CompatStepOptions {
  readonly timeout?: number;
}

/** Same shape a `config.parameterTypes` entry takes — `regexp`/`transformer`
 * are handed to `@cucumber/cucumber-expressions`' own `ParameterType` almost
 * verbatim, same as the config-origin path (src/binding/registry.ts). */
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

/** `value` is a plain options object — not a function (the 2-argument form),
 * and not `null`/an array/a string either, none of which this registration
 * API accepts as an options object (this task's spec, decision 2: throw
 * even when options is not an object). */
function isStepOptionsObject(value: CompatStepOptions | CompatStepFn): value is CompatStepOptions {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function registerStep(
  keyword: CompatKeyword,
  pattern: CompatPattern,
  optionsOrFn: CompatStepOptions | CompatStepFn,
  maybeFn: CompatStepFn | undefined,
): void {
  if (typeof optionsOrFn === "function") {
    stepBuffer.push({ keyword, pattern, fn: optionsOrFn, registrationOrder: registrationCounter++ });
    return;
  }
  if (!isStepOptionsObject(optionsOrFn)) {
    throw new Error(
      `${keyword}(${String(pattern)}, options, fn): options must be an object, got ${JSON.stringify(optionsOrFn)}`,
    );
  }
  const unknownKeys = Object.keys(optionsOrFn).filter((key) => key !== "timeout");
  if (unknownKeys.length > 0) {
    // A door that stays quiet is worse than one that's briefly noisy: an
    // unrecognized option key must not silently vanish the way `{ timeout }`
    // used to before this task closed that case (this task's spec, decision
    // 2) — so any *other* unknown key gets the exact same treatment, up
    // front, rather than waiting to become a future silent gap of its own.
    throw new Error(
      `${keyword}(${String(pattern)}, options, fn): unsupported option key "${unknownKeys[0]}"` +
        ` (only "timeout" is supported)`,
    );
  }
  if (maybeFn === undefined) {
    throw new Error(`${keyword}(pattern, options, fn) requires a function as its third argument`);
  }
  stepBuffer.push({
    keyword,
    pattern,
    fn: maybeFn,
    timeoutMs: optionsOrFn.timeout,
    registrationOrder: registrationCounter++,
  });
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
 *
 * `Given(pattern, fn)`: the original 2-argument form.
 */
export function Given(pattern: CompatPattern, fn: CompatStepFn): void;
/** `Given(pattern, { timeout }, fn)`: cucumber-js's own 3-argument form
 * (this task's spec, decision 2). */
export function Given(pattern: CompatPattern, options: CompatStepOptions, fn: CompatStepFn): void;
export function Given(
  pattern: CompatPattern,
  optionsOrFn: CompatStepOptions | CompatStepFn,
  maybeFn?: CompatStepFn,
): void {
  registerStep("Given", pattern, optionsOrFn, maybeFn);
}

/** `When(pattern, fn)`: the original 2-argument form. */
export function When(pattern: CompatPattern, fn: CompatStepFn): void;
/** `When(pattern, { timeout }, fn)`: cucumber-js's own 3-argument form. */
export function When(pattern: CompatPattern, options: CompatStepOptions, fn: CompatStepFn): void;
export function When(
  pattern: CompatPattern,
  optionsOrFn: CompatStepOptions | CompatStepFn,
  maybeFn?: CompatStepFn,
): void {
  registerStep("When", pattern, optionsOrFn, maybeFn);
}

/** `Then(pattern, fn)`: the original 2-argument form. */
export function Then(pattern: CompatPattern, fn: CompatStepFn): void;
/** `Then(pattern, { timeout }, fn)`: cucumber-js's own 3-argument form. */
export function Then(pattern: CompatPattern, options: CompatStepOptions, fn: CompatStepFn): void;
export function Then(
  pattern: CompatPattern,
  optionsOrFn: CompatStepOptions | CompatStepFn,
  maybeFn?: CompatStepFn,
): void {
  registerStep("Then", pattern, optionsOrFn, maybeFn);
}

/**
 * Registers a custom cucumber-expressions parameter type from compat
 * ("support") code. Layered into the *same* `ParameterTypeRegistry` as
 * config-origin entries by src/binding/registry.ts, not a registry of its
 * own — a name collision between the two sources is caught there exactly
 * like a collision between two config entries, and moving a registration
 * from here to config later changes nothing about what any pattern matches.
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

/**
 * cucumber-js's own `setDefaultTimeout(ms)` (m22-compat-run-scope task spec,
 * item 1) — the timeout a compat step or hook falls back to when it
 * declares no `{ timeout }` of its own (src/run/run-scenario.ts applies the
 * fallback for a scenario's own compat steps/Before/After, src/cli/run.ts
 * for BeforeAll/AfterAll; this module only records the value, same split as
 * this file's own per-registration `timeoutMs` fields). Last call wins
 * (this task's spec: the last call wins when called more than once —
 * cucumber-js's own documented behavior, so no detection/warning is added for a second call).
 * Deliberately *not* seeded with cucumber-js's own 5000ms default when never
 * called at all: nukadoko's compat steps/hooks have always run unbounded
 * absent their own `{ timeout }`, and introducing a 5-second ceiling here
 * would make an existing suite's slow step start failing purely from
 * switching to nukadoko — the exact regression the migration door forbids
 * (docs/spec.md, migration-door rule). This choice is documented for
 * readers in docs/migration.md (a later task; not this one).
 */
let defaultTimeoutMs: number | undefined;

export function setDefaultTimeout(ms: number): void {
  defaultTimeoutMs = ms;
}

/** Read once, at the end of a discovery run (src/discover/discover-
 * steps.ts) — never reset mid-run, since (unlike `stepBuffer`) this is a
 * single value with no per-file attribution to preserve. */
export function getDefaultTimeoutMs(): number | undefined {
  return defaultTimeoutMs;
}
