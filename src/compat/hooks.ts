// Responsibility: Before/After hook registration — the same registration-
// buffer shape as src/compat/registry.ts's Given/When/Then (a step file's
// top-level call pushes onto a module-level array; src/discover/discover-
// steps.ts reads it back through the same namespaced import, for the same
// module-identity reason that file's own header documents), except a hook
// is never attributed to a file: a Before/After hook is a property of the
// whole discovery/run, not of the vocabulary, so there is nothing here for
// `nuka steps`/`nuka check` to list or duplicate-detect. `getRegisteredHooks()`
// is read exactly once, at the very end of a discovery run; the buffer is
// never drained mid-run — each discovery run gets its own module instance
// (a namespace per run, src/config/ts-loader.ts, same as registry.ts), so a fresh, empty buffer
// is what every run already starts with.
//
// `HookOptions.timeout` and `HookParameter` are added here (this module
// still only *records* what was called — enforcing the timeout and
// actually building a `HookParameter` at call time are
// src/run/run-scenario.ts's job, same split as src/compat/registry.ts's own
// `CompatStepOptions.timeout`/`timeoutMs`).
//
// `AfterStep` is added: the compat audit counted it once, in one real-world
// repo, but an ESM named import that misses one name drops the whole
// `import { ... }` statement's file, so even one occurrence is a full
// file's worth of real damage. Registration form is deliberately identical
// to `Before`/`After` (same three call shapes, same tag-expression subset,
// same `registerHook`): `AfterStep` invents no new registration vocabulary
// of its own.

import type { Duration, GherkinDocument, Pickle, PickleStep } from "@cucumber/messages";
import { refuseUnkeptTimeout } from "./registry.js";

/** `"after_step"` — for `AfterStep`, alongside the pre-existing `Before`/
 * `After`. Registration is identical for all three (`registerHook`, this
 * file); only *execution* (src/run/run-scenario.ts) treats `"after_step"`
 * differently, since it runs once per executed pickle step rather than
 * once per scenario. */
export type HookType = "before" | "after" | "after_step";

/**
 * cucumber-js's own `ITestCaseHookParameter` shape — the argument every
 * Before/After hook now receives as its first parameter. Real-world glue
 * destructures this directly (e.g.
 * `Before(function ({ pickle }) {...})`, 10 call sites across 4 repos per
 * the compat audit); previously nukadoko called every hook with zero
 * arguments, so that destructuring crashed outright, and a plain
 * `this.scenario?.gherkinDocument?...`-style read (never crashing) silently
 * always took the same branch.
 */
export interface HookParameter {
  readonly gherkinDocument: GherkinDocument;
  readonly pickle: Pickle;
  /** nukadoko's own scenario id (src/run/scenario-id.ts), NOT a cucumber
   * message id — cucumber-js's own `testCaseStartedId` names a
   * `TestCaseStarted` envelope this project never emits. Kept under the
   * same field name real glue already reads, so that read resolves to a
   * real, stable, per-scenario string instead of `undefined`. */
  readonly testCaseStartedId: string;
  /** After-hook and AfterStep-hook only (cucumber-js itself never sets this
   * for Before) — for After, the scenario's own outcome so far; for
   * AfterStep, that one step's own outcome, not the scenario's. `status`
   * reuses cucumber's own `Status` enum's *string values*
   * (`"PASSED"`/`"FAILED"`) — and `nukadoko/compat` also re-exports that
   * exact enum, under the same name, as `Status` (src/compat/index.ts,
   * re-exporting `@cucumber/messages`'s `TestStepResultStatus` verbatim), so
   * glue written as `result.status === Status.FAILED` now imports and
   * compares correctly.
   * This comment used to claim `@cucumber/cucumber` doesn't export `Status`
   * either — that was simply wrong (cucumber-js does; the compat audit
   * counted that exact `result.status === Status.FAILED` shape 3 times,
   * across 3 real-world repos). The equally common
   * `result.status === "FAILED"` string comparison still means what it
   * always meant, unaffected by the enum's own re-export.
   * `duration` is cucumber's own `Duration` (seconds and nanos) for the
   * step this result describes, taken from the start and finish the
   * executor already recorded for that step. `message` is that same
   * failure's text, and only when the outcome is a failure: a passing
   * result has no message, matching cucumber-js, which adds one only
   * from the thrown value. */
  readonly result?: {
    readonly status: "PASSED" | "FAILED";
    readonly duration: Duration;
    readonly message?: string;
  };
  /** After and AfterStep only. cucumber-js assigns this key whenever it
   * assigns `result`, including when the value is `undefined` (a pass, or
   * a failure that was not a throw). Before omits the key: nothing has
   * failed yet. The value, when there is one, is the thrown value the
   * executor already caught, not a second error built for the hook. */
  readonly error?: unknown;
  /** AfterStep only. The pickle step that just ran. Absent on Before and
   * After, which cucumber-js does not give a `pickleStep`. */
  readonly pickleStep?: PickleStep;
  /** AfterStep only. The step record id of the step that just ran.
   * cucumber-js's `testStepId` names a `TestStep` assigned when the test
   * case is built. This executor does not assign cucumber-messages ids
   * until `nuka report` renders the run, long after the hook was called, so
   * the field uses the id the executor already holds for that step. Same
   * reason `testCaseStartedId` above is the scenario id: a read of the
   * name real glue already uses has to resolve to a real, stable, per-step
   * string instead of `undefined`. */
  readonly testStepId?: string;
  /** nukadoko has no retry mechanism, so this is always `false` — present
   * because real glue destructures it as a sibling of the fields above, and
   * an omitted field there is `undefined`, not `false`. */
  readonly willBeRetried: false;
}

/** `HookParameter` under cucumber-js's own name (the compat audit found
 * `ITestCaseHookParameter` appears in 2/2 real-world repos as a bare type
 * import) — the same `tsc`-only gap `IWorldOptions` closed for world.ts,
 * for the same reason (see that alias's
 * own doc comment). Before and After use the fields cucumber-js puts on
 * `ITestCaseHookParameter`. AfterStep also sets `pickleStep` and
 * `testStepId`, which cucumber-js puts on `ITestStepHookParameter` and
 * leaves off the scenario hook. One type covers both calls because one
 * `HookFn` has to, and the step-only fields are optional so a Before or
 * After that never reads them is unchanged. */
export type ITestCaseHookParameter = HookParameter;

/** `this: any`, not `this: World` (same reasoning as src/compat/registry.ts's
 * `CompatStepFn`): a hook is called against whichever World subclass
 * `setWorldConstructor` registered, and a real hook function typically
 * types its own `this` as that specific subclass (e.g. `function (this:
 * CustomWorld) {...}`) to reach its own fields — `this: World` here would
 * make TypeScript reject every such function outright (the `this` type
 * check is contravariant: a narrower `this` than the target's is unsound in
 * general, even though it is exactly what a hook function needs in
 * practice). `any` sidesteps that check the same way it already does for
 * step glue functions. A function that declares fewer parameters than
 * `HookParameter` still satisfies this type (TypeScript lets a function
 * value ignore trailing parameters), so a plain `Before(function () {...})`
 * keeps typechecking unchanged. The trailing `...rest: any[]` exists for the
 * opposite case: real done-callback-style glue declares one *more*
 * parameter than nukadoko ever passes (e.g. `function
 * (hookParameter, done) {...}`) — without a rest tail here, TypeScript's own
 * static arity check would reject that shape outright, before
 * src/run/run-scenario.ts's own runtime arity check ever got a chance to
 * fail it with a readable message instead. Same reasoning as
 * src/compat/registry.ts's `CompatStepFn`'s own `...args: any[]`. */
export type HookFn = (
  this: any,
  hookParameter: HookParameter,
  ...rest: any[]
) => unknown | Promise<unknown>;

export interface HookOptions {
  /** v1's tag expression subset: a single `@tag`, or its negation
   * `not @tag` (src/compat/tag-expression.ts). `undefined` (the plain
   * `Before(fn)`/`After(fn)` form) applies to every scenario. */
  readonly tags?: string;
  /** cucumber-js's own per-hook timeout override, in milliseconds (the
   * compat audit found 14 real-world call sites, 3 repos, previously
   * silently dropped — `HookOptions` only ever had `tags`).
   * Enforced by src/run/run-scenario.ts; this module only records it (see
   * this file's own header). */
  readonly timeout?: number;
  /** cucumber-js metadata: the hook's title where a title is shown.
   * It does not select scenarios, change the timeout, or change order.
   * `AfterStep` does not accept this field. cucumber-js step-hook options
   * have no name, so a title there would be one cucumber-js never shows. */
  readonly name?: string;
}

export interface HookRegistration {
  readonly type: HookType;
  readonly tags: string | undefined;
  readonly fn: HookFn;
  /** From `{ timeout }` — see `HookOptions.timeout`'s own comment. */
  readonly timeoutMs?: number;
  /** From `{ name }`. Absent when the caller did not pass one. */
  readonly name?: string;
  readonly registrationOrder: number;
}

const hookBuffer: HookRegistration[] = [];
let hookCounter = 0;

/** Same "is this a plain options object" guard as src/compat/registry.ts's
 * `isStepOptionsObject` — not a function, and not `null`/an array either,
 * neither of which this registration API accepts as an options object. */
function isHookOptionsObject(value: HookOptions | HookFn | string): value is HookOptions {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function registerHook(
  type: HookType,
  optionsOrFn: HookOptions | HookFn | string,
  maybeFn: HookFn | undefined,
): void {
  const label = type === "before" ? "Before" : type === "after" ? "After" : "AfterStep";

  if (typeof optionsOrFn === "function") {
    hookBuffer.push({ type, tags: undefined, fn: optionsOrFn, registrationOrder: hookCounter++ });
    return;
  }

  // cucumber-js accepts a bare tag-expression string in place of `{ tags }`
  // (the compat audit found 10 real-world call sites, 2 repos, use
  // exactly this shape) — folded into the same `tags` field as the options
  // form so every downstream reader (tag-expression.ts, src/run/) sees one
  // representation regardless of which shape the caller used.
  if (typeof optionsOrFn === "string") {
    if (maybeFn === undefined) {
      throw new Error(`${label}(tags, fn) requires a function as its second argument`);
    }
    hookBuffer.push({ type, tags: optionsOrFn, fn: maybeFn, registrationOrder: hookCounter++ });
    return;
  }

  if (!isHookOptionsObject(optionsOrFn)) {
    throw new Error(`${label}(options, fn): options must be an object, got ${JSON.stringify(optionsOrFn)}`);
  }

  // `name` is a title. `AfterStep` has no such field in cucumber-js, so it
  // stays an unknown key there. `on` stays unknown for every type: it would
  // choose which process runs the hook.
  const recognized = type === "after_step" ? ["tags", "timeout"] : ["tags", "timeout", "name"];
  const unknownKeys = Object.keys(optionsOrFn).filter((key) => !recognized.includes(key));
  if (unknownKeys.length > 0) {
    // Same "a door that stays quiet is worse than one that's briefly noisy"
    // reasoning as src/compat/registry.ts's own unknown-key check: before
    // `HookOptions.timeout` was added, `HookOptions` only read `tags`, so a
    // `{ timeout }` key passed alongside it vanished silently; any *other*
    // unrecognized key gets the same up-front treatment rather than
    // becoming a future silent gap of its own.
    const supported = recognized.map((key) => `"${key}"`).join("/");
    throw new Error(
      `${label}(options, fn): unsupported option key "${unknownKeys[0]}" (only ${supported} are supported)`,
    );
  }

  if (type !== "after_step" && optionsOrFn.name !== undefined && typeof optionsOrFn.name !== "string") {
    throw new Error(`${label}(options, fn): "name" must be a string`);
  }

  if (maybeFn === undefined) {
    throw new Error(`${label}({ tags, timeout }, fn) requires a function as its second argument`);
  }
  refuseUnkeptTimeout(`${label}({ timeout }, fn)`, optionsOrFn.timeout);

  hookBuffer.push({
    type,
    tags: optionsOrFn.tags,
    timeoutMs: optionsOrFn.timeout,
    ...(typeof optionsOrFn.name === "string" ? { name: optionsOrFn.name } : {}),
    fn: maybeFn,
    registrationOrder: hookCounter++,
  });
}

/** `Before(fn)`: runs for every scenario. */
export function Before(fn: HookFn): void;
/** `Before({ tags }, fn)`: runs only for a scenario matching `tags`
 * (src/compat/tag-expression.ts). */
export function Before(options: HookOptions, fn: HookFn): void;
/** `Before("@tag", fn)` / `Before("not @tag", fn)`: cucumber-js's own bare
 * tag-expression-string shorthand for `{ tags }` — same tag-expression
 * handling as the options form (src/compat/tag-expression.ts). */
export function Before(tags: string, fn: HookFn): void;
export function Before(optionsOrFn: HookOptions | HookFn | string, fn?: HookFn): void {
  registerHook("before", optionsOrFn, fn);
}

/** `After(fn)`: attempted for every scenario, regardless of how it went. */
export function After(fn: HookFn): void;
/** `After({ tags }, fn)`: attempted only for a scenario matching `tags`. */
export function After(options: HookOptions, fn: HookFn): void;
/** `After("@tag", fn)` / `After("not @tag", fn)`: same bare-string shorthand
 * as `Before`. */
export function After(tags: string, fn: HookFn): void;
export function After(optionsOrFn: HookOptions | HookFn | string, fn?: HookFn): void {
  registerHook("after", optionsOrFn, fn);
}

/** `AfterStep(fn)`: attempted after every step that actually ran in this
 * scenario — not after a step this scenario skipped because an earlier one
 * already failed: a skipped step never began, so there is no "after" for
 * this hook to run at.
 * See src/run/run-scenario.ts's own `runAfterStepHooks` for where that
 * boundary is actually drawn at execution time (this file only registers). */
export function AfterStep(fn: HookFn): void;
/** `AfterStep({ tags }, fn)`: attempted only for a scenario matching
 * `tags` — same single-`@tag`/`not @tag` support as `Before`/`After`
 * (src/compat/tag-expression.ts), no new tag-filter mechanism of its own.
 * No `name`: cucumber-js step-hook options do not have one. */
export function AfterStep(
  options: { readonly tags?: string; readonly timeout?: number },
  fn: HookFn,
): void;
/** `AfterStep("@tag", fn)` / `AfterStep("not @tag", fn)`: same bare-string
 * shorthand as `Before`/`After`. */
export function AfterStep(tags: string, fn: HookFn): void;
export function AfterStep(optionsOrFn: HookOptions | HookFn | string, fn?: HookFn): void {
  registerHook("after_step", optionsOrFn, fn);
}

/** Read once, at the end of a discovery run (src/discover/discover-
 * steps.ts) — never drained, since (unlike a compat step) a hook is not
 * attributed to any one file. */
export function getRegisteredHooks(): readonly HookRegistration[] {
  return hookBuffer;
}
