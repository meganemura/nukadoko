// Responsibility: BeforeAll/AfterAll registration — the run-scope
// counterpart of src/compat/hooks.ts's per-scenario Before/After. Same
// module-level-buffer registration shape and
// the same module-identity handoff to src/discover/discover-steps.ts's
// scoped tsx import (see hooks.ts's own header for why that identity
// matters); kept as its own module rather than folded into hooks.ts because
// cucumber-js's own BeforeAll/AfterAll differ from Before/After in every
// dimension that module's types encode: no `tags` (a tag
// has no meaning for a run-scope hook — there is no per-scenario pickle for a
// tag expression to match against), no `HookParameter` argument (cucumber-js
// itself calls a run-scope hook with zero arguments — there is no
// pickle/gherkinDocument/testCaseStartedId for one run to hand it), and
// `this` is never bound to anything (see `RunHookFn`'s own comment).
// Execution (src/cli/run.ts, around the whole scenario loop, once per `nuka
// run` invocation) is src/cli/run.ts's job; this module only records what
// was called.

export type RunHookType = "beforeAll" | "afterAll";

/**
 * `this: any`, and never actually bound to anything at call time (`this` is
 * never bound to a World — at BeforeAll time no pickle has
 * been selected for execution yet and no World has been constructed for one
 * either; a World is created per pickle, src/run/run-scenario.ts, strictly
 * after BeforeAll would have already run). `...args: any[]` exists purely so
 * a done-callback-style function (declaring one parameter cucumber-js would
 * treat as `done`) still typechecks — src/cli/run.ts's own runtime arity
 * check (same "declares more than nukadoko ever passes" signal as
 * src/compat/hooks.ts's `HookFn`) is what actually rejects that shape with a
 * readable message, not TypeScript. Since a run-scope hook is called with
 * *zero* arguments (unlike Before/After's single `HookParameter`), any
 * declared parameter at all — not just a second one — is that signal here.
 */
export type RunHookFn = (this: any, ...args: any[]) => unknown | Promise<unknown>;

export interface RunHookOptions {
  /** cucumber-js's own per-hook timeout override, in milliseconds — same
   * meaning as src/compat/hooks.ts's `HookOptions.timeout`. Enforced by
   * src/cli/run.ts; this module only records it. */
  readonly timeout?: number;
}

export interface RunHookRegistration {
  readonly type: RunHookType;
  readonly fn: RunHookFn;
  /** From `{ timeout }` — see `RunHookOptions.timeout`'s own comment. */
  readonly timeoutMs?: number;
  readonly registrationOrder: number;
}

const runHookBuffer: RunHookRegistration[] = [];
let runHookCounter = 0;

/** Same "is this a plain options object" guard as src/compat/hooks.ts's
 * `isHookOptionsObject` — not a function, and not `null`/an array either. */
function isRunHookOptionsObject(value: RunHookOptions | RunHookFn): value is RunHookOptions {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function registerRunHook(
  type: RunHookType,
  optionsOrFn: RunHookOptions | RunHookFn,
  maybeFn: RunHookFn | undefined,
): void {
  const label = type === "beforeAll" ? "BeforeAll" : "AfterAll";

  if (typeof optionsOrFn === "function") {
    runHookBuffer.push({ type, fn: optionsOrFn, registrationOrder: runHookCounter++ });
    return;
  }

  if (!isRunHookOptionsObject(optionsOrFn)) {
    throw new Error(
      `${label}(options, fn): options must be an object, got ${JSON.stringify(optionsOrFn)}`,
    );
  }

  // Only "timeout" is recognized — in particular, *not* "tags": run-scope
  // hooks don't accept one at all, unlike Before/After.
  // Same "a door that stays quiet is worse than one that's briefly noisy"
  // reasoning as src/compat/hooks.ts's own unknown-key check: an
  // unrecognized key throws immediately rather than vanishing silently.
  const unknownKeys = Object.keys(optionsOrFn).filter((key) => key !== "timeout");
  if (unknownKeys.length > 0) {
    throw new Error(
      `${label}(options, fn): unsupported option key "${unknownKeys[0]}" (only "timeout" is supported)`,
    );
  }

  if (maybeFn === undefined) {
    throw new Error(`${label}({ timeout }, fn) requires a function as its second argument`);
  }

  runHookBuffer.push({
    type,
    timeoutMs: optionsOrFn.timeout,
    fn: maybeFn,
    registrationOrder: runHookCounter++,
  });
}

/** `BeforeAll(fn)`: runs once, before the first pickle in this `nuka run`
 * invocation — but only when at least one pickle was actually selected for
 * execution (src/cli/run.ts: BeforeAll/AfterAll never run when zero pickles were selected). */
export function BeforeAll(fn: RunHookFn): void;
/** `BeforeAll({ timeout }, fn)`: same per-hook timeout override as `Before`. */
export function BeforeAll(options: RunHookOptions, fn: RunHookFn): void;
export function BeforeAll(optionsOrFn: RunHookOptions | RunHookFn, fn?: RunHookFn): void {
  registerRunHook("beforeAll", optionsOrFn, fn);
}

/** `AfterAll(fn)`: attempted once, after the last pickle, regardless of how
 * the run went — including when `BeforeAll` itself failed (src/cli/run.ts:
 * AfterAll is still attempted even when BeforeAll failed). */
export function AfterAll(fn: RunHookFn): void;
/** `AfterAll({ timeout }, fn)`: same per-hook timeout override as `After`. */
export function AfterAll(options: RunHookOptions, fn: RunHookFn): void;
export function AfterAll(optionsOrFn: RunHookOptions | RunHookFn, fn?: RunHookFn): void {
  registerRunHook("afterAll", optionsOrFn, fn);
}

/** Read once, at the end of a discovery run (same contract as
 * src/compat/hooks.ts's `getRegisteredHooks`) — never drained, since a
 * BeforeAll/AfterAll hook is not attributed to any one file either. */
export function getRegisteredRunHooks(): readonly RunHookRegistration[] {
  return runHookBuffer;
}
