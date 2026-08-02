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

export type HookType = "before" | "after";
/** `this: any`, not `this: World` (same reasoning as src/compat/registry.ts's
 * `CompatStepFn`): a hook is called against whichever World subclass
 * `setWorldConstructor` registered, and a real hook function typically
 * types its own `this` as that specific subclass (e.g. `function (this:
 * CustomWorld) {...}`) to reach its own fields — `this: World` here would
 * make TypeScript reject every such function outright (the `this` type
 * check is contravariant: a narrower `this` than the target's is unsound in
 * general, even though it is exactly what a hook function needs in
 * practice). `any` sidesteps that check the same way it already does for
 * step glue functions. */
export type HookFn = (this: any) => unknown | Promise<unknown>;

export interface HookOptions {
  /** v1's tag expression subset: a single `@tag`, or its negation
   * `not @tag` (src/compat/tag-expression.ts). `undefined` (the plain
   * `Before(fn)`/`After(fn)` form) applies to every scenario. */
  readonly tags?: string;
}

export interface HookRegistration {
  readonly type: HookType;
  readonly tags: string | undefined;
  readonly fn: HookFn;
  readonly registrationOrder: number;
}

const hookBuffer: HookRegistration[] = [];
let hookCounter = 0;

function registerHook(
  type: HookType,
  optionsOrFn: HookOptions | HookFn | string,
  maybeFn: HookFn | undefined,
): void {
  const isFnForm = typeof optionsOrFn === "function";
  // cucumber-js accepts a bare tag-expression string in place of `{ tags }`
  // (m2.1-a compat-audit synthesis: 10 real-world call sites, 2 repos, use
  // exactly this shape) — folded into the same `tags` field as the options
  // form so every downstream reader (tag-expression.ts, src/run/) sees one
  // representation regardless of which shape the caller used.
  const tags = isFnForm ? undefined : typeof optionsOrFn === "string" ? optionsOrFn : optionsOrFn.tags;
  const fn = isFnForm ? optionsOrFn : maybeFn;
  const label = type === "before" ? "Before" : "After";
  if (fn === undefined) {
    throw new Error(`${label}({ tags }, fn) requires a function as its second argument`);
  }
  hookBuffer.push({ type, tags, fn, registrationOrder: hookCounter++ });
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
