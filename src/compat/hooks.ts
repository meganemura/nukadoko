// Responsibility: Before/After hook registration (m2b-compat-execution task
// spec, item 5) — the same registration-buffer shape as src/compat/
// registry.ts's Given/When/Then (a step file's top-level call pushes onto a
// module-level array; src/discover/discover-steps.ts reads it back through
// the same scoped tsx import, for the same module-identity reason that
// file's own header documents), except a hook is never attributed to a
// file: a Before/After hook is a property of the whole discovery/run, not
// of the vocabulary, so there is nothing here for `nuka steps`/`nuka check`
// to list or duplicate-detect. `getRegisteredHooks()` is read exactly once,
// at the very end of a discovery run; the buffer is never drained mid-run —
// each discovery run gets its own module instance (tsx's per-run namespace,
// same as registry.ts), so a fresh, empty buffer is what every run already
// starts with.
//
// m21b-compat-execution task spec, items 1 and 3: `HookOptions.timeout` and
// `HookParameter` are added here (this module still only *records* what was
// called — enforcing the timeout and actually building a `HookParameter` at
// call time are src/run/run-scenario.ts's job, same split as
// src/compat/registry.ts's own `CompatStepOptions.timeout`/`timeoutMs`).

import type { GherkinDocument, Pickle } from "@cucumber/messages";

export type HookType = "before" | "after";

/**
 * cucumber-js's own `ITestCaseHookParameter` shape (m21b-compat-execution
 * task spec, item 3) — the argument every Before/After hook now receives as
 * its first parameter. Real-world glue destructures this directly (e.g.
 * `Before(function ({ pickle }) {...})`, 10 call sites across 4 repos per
 * the m2.1-a compat-audit synthesis); previously nukadoko called every hook
 * with zero arguments, so that destructuring crashed outright, and a plain
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
  /** After-hook only (cucumber-js itself never sets this for Before).
   * `status` reuses cucumber's own `Status` enum's *string values*
   * (`"PASSED"`/`"FAILED"`), not the enum itself: `@cucumber/cucumber` does
   * not export `Status`, so glue written as `result.status === Status.FAILED`
   * would fail to even import, while the equally common
   * `result.status === "FAILED"` string comparison keeps meaning what it
   * always meant. */
  readonly result?: { readonly status: "PASSED" | "FAILED" };
  /** nukadoko has no retry mechanism, so this is always `false` — present
   * because real glue destructures it as a sibling of the fields above, and
   * an omitted field there is `undefined`, not `false`. */
  readonly willBeRetried: false;
}

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
 * opposite case (this task's spec, item 5): real done-callback-style glue
 * declares one *more* parameter than nukadoko ever passes (e.g. `function
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
  /** cucumber-js's own per-hook timeout override, in milliseconds (m21b-
   * compat-execution task spec, item 1: 14 real-world call sites, 3 repos,
   * previously silently dropped — `HookOptions` only ever had `tags`).
   * Enforced by src/run/run-scenario.ts; this module only records it (see
   * this file's own header). */
  readonly timeout?: number;
}

export interface HookRegistration {
  readonly type: HookType;
  readonly tags: string | undefined;
  readonly fn: HookFn;
  /** From `{ timeout }` — see `HookOptions.timeout`'s own comment. */
  readonly timeoutMs?: number;
  readonly registrationOrder: number;
}

const hookBuffer: HookRegistration[] = [];
let hookCounter = 0;

/** Same "is this a plain options object" guard as src/compat/registry.ts's
 * `isStepOptionsObject` (m21b-compat-execution task spec, item 1: align the
 * implementation approach too) — not a function, and not `null`/an array either, neither of
 * which this registration API accepts as an options object. */
function isHookOptionsObject(value: HookOptions | HookFn | string): value is HookOptions {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function registerHook(
  type: HookType,
  optionsOrFn: HookOptions | HookFn | string,
  maybeFn: HookFn | undefined,
): void {
  const label = type === "before" ? "Before" : "After";

  if (typeof optionsOrFn === "function") {
    hookBuffer.push({ type, tags: undefined, fn: optionsOrFn, registrationOrder: hookCounter++ });
    return;
  }

  // cucumber-js accepts a bare tag-expression string in place of `{ tags }`
  // (m2.1-a compat-audit synthesis: 10 real-world call sites, 2 repos, use
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

  const unknownKeys = Object.keys(optionsOrFn).filter((key) => key !== "tags" && key !== "timeout");
  if (unknownKeys.length > 0) {
    // Same "a door that stays quiet is worse than one that's briefly noisy"
    // reasoning as src/compat/registry.ts's own unknown-key check (m21b-
    // compat-execution task spec, item 1): `{ timeout }` itself used to
    // vanish silently before this task closed that case; any *other*
    // unrecognized key gets the same up-front treatment rather than
    // becoming a future silent gap of its own.
    throw new Error(
      `${label}(options, fn): unsupported option key "${unknownKeys[0]}" (only "tags"/"timeout" are supported)`,
    );
  }

  if (maybeFn === undefined) {
    throw new Error(`${label}({ tags, timeout }, fn) requires a function as its second argument`);
  }

  hookBuffer.push({
    type,
    tags: optionsOrFn.tags,
    timeoutMs: optionsOrFn.timeout,
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

/** Read once, at the end of a discovery run (src/discover/discover-
 * steps.ts) — never drained, since (unlike a compat step) a hook is not
 * attributed to any one file. */
export function getRegisteredHooks(): readonly HookRegistration[] {
  return hookBuffer;
}
