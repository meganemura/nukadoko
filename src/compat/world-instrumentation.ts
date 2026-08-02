import type { z } from "zod";
import { formatValidationIssues } from "../binding/format-issues.js";
import { ReservedWorldKeyWriteError, WorldWriteValidationError } from "./errors.js";

// Responsibility: the wrap mechanism behind "measurement is always on,
// declaration is opt-in" for a compat World instance (m2c-typed-world task
// spec; .claude-team/proto-typed-world/findings.md is the empirical record
// this file's every decision traces back to). The measured surface is the
// instance's own DATA properties only — a class's methods/getters (own or
// inherited) are left completely alone, and a `#private` field is invisible
// to this module by construction (it never appears in `Object.keys`/
// `getOwnPropertyDescriptor` at all): that is a named boundary, not a bug
// (findings' own conclusion).
//
// Proxy is deliberately not used here (findings Q3): wrapping `target` in a
// `new Proxy(target, {...})` and handing the proxy out as `this` breaks any
// method that touches a `#private` field with `TypeError: Cannot read
// private member ... from an object whose class did not declare it`,
// because the method then runs with `this = proxy`, not the real instance
// the private field actually lives on. This module instead replaces each
// own data property directly on `target` itself with an accessor pair
// (`Object.defineProperty`), so the object handed out as `this` is always
// the literal instance — `proxy === target`, in the prototype's own
// language — and `#private` access from any method keeps working exactly as
// if this module didn't exist.
//
// Seeding (findings' "hole 2"): a `defineWorld`-declared key that doesn't
// exist yet on the instance (e.g. `z.object({...}).optional()`, legitimately
// absent until first write) must still get its accessor at wrap time, or its
// first write silently skips validation. `reconcile()` below seeds
// `Object.keys(target) ∪ Object.keys(declaredSchemas)` every time it runs,
// not just once, so this holds both at wrap time and after every later call.
//
// Reconcile / one-step-behind limit (findings' "hole 1", partial fix): a key
// that first appears as a plain own property *after* wrap (an undeclared
// bag field a step assigns for the first time) has no accessor yet, so that
// first write is not measured. `reconcile()` is meant to be called at every
// step boundary (the same points src/run/run-scenario.ts calls
// `contextHandle.beginStep()` — before Before hooks, before each step,
// before After hooks); a key created by step N's own body only starts being
// measured from step N+1 onward. This is a documented limit, not a bug: a
// key that shows up mid-step-N's own execution is exactly one step behind
// the accessor that would have caught it. Hook execution sits between two
// `beginStep()`-equivalent resets the same way it already does for
// `observed`/`used` (src/context/observed.ts, src/context/used.ts): a
// hook's own World reads/writes accumulate against the tally, then that
// tally is zeroed again before the first real step ever gets its snapshot,
// so a hook's own World access is never attributed to any step's receipt.
//
// Reserved keys (findings Q5, from `@cucumber/cucumber`'s own published
// world.d.ts/world.js): `attach`/`log`/`link`/`parameters` are, at run time,
// ordinary own writable data properties despite being typed `readonly`
// upstream — indistinguishable from a user's own bag field by descriptor
// inspection alone. They are excluded from measurement (reading them to
// call `this.attach(...)` is not "data flow" worth recording) and from
// `defineWorld` declaration (src/compat/define-world.ts's own registration-
// time check), and reassigning one is a run-time error here — silently
// letting `this.attach = "oops"` through would leave every later
// `this.attach(...)` call throwing deep inside cucumber-style glue instead
// of at the point of the actual mistake (findings Q5's own reproduction).

export const RESERVED_WORLD_KEYS: ReadonlySet<string> = new Set([
  "attach",
  "log",
  "link",
  "parameters",
]);

export interface WorldReadsWrites {
  readonly reads: string[];
  readonly writes: string[];
}

export interface WorldInstrumentationHandle {
  /**
   * Advances to the next step boundary: seeds accessors for any own data key
   * that appeared on the instance since the last call (or since wrap), then
   * zeroes this step's own reads/writes tally. Call at the exact points
   * src/run/run-scenario.ts calls `contextHandle.beginStep()`.
   */
  beginStep(): void;
  /**
   * Reads/writes tallied since the last `beginStep()`, deduplicated, in
   * first-access order (mirrors `used`'s own contract, src/context/used.ts).
   */
  snapshot(): WorldReadsWrites;
}

/** An own property that is plain "bag" data — not a method, not an already-
 * installed accessor — the only shape this module ever measures or wraps.
 * Instance-own descriptor inspection, not `typeof Reflect.get(...)`: the
 * latter runs a getter and inspects its *return value*, which cannot tell a
 * data property holding a function apart from an actual method (findings
 * Q2's own empirical correction). */
function isOwnPlainDataKey(target: object, key: string): boolean {
  const desc = Object.getOwnPropertyDescriptor(target, key);
  if (desc === undefined) return false;
  if (typeof desc.value === "function") return false;
  if (desc.get || desc.set) return false;
  return true;
}

export function instrumentWorld<T extends object>(
  target: T,
  declaredSchemas: Readonly<Record<string, z.ZodTypeAny>>,
): WorldInstrumentationHandle {
  const shadow = new Map<string, unknown>();
  const instrumented = new Set<string>();

  let reads: string[] = [];
  let readsSeen = new Set<string>();
  let writes: string[] = [];
  let writesSeen = new Set<string>();

  function recordRead(key: string): void {
    if (!readsSeen.has(key)) {
      readsSeen.add(key);
      reads.push(key);
    }
  }

  function recordWrite(key: string): void {
    if (!writesSeen.has(key)) {
      writesSeen.add(key);
      writes.push(key);
    }
  }

  function defineReserved(key: string): void {
    // Captured once, not read through `shadow`: a reserved key can never be
    // reassigned (the setter always throws), so there is nothing later to
    // invalidate this closure's own copy of the original value.
    const original = (target as Record<string, unknown>)[key];
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get() {
        // Deliberately not recorded — reading `this.attach` to call it is
        // not the "data flow" this mechanism exists to surface.
        return original;
      },
      set() {
        throw new ReservedWorldKeyWriteError(key);
      },
    });
    instrumented.add(key);
  }

  function defineMeasured(key: string): void {
    shadow.set(key, (target as Record<string, unknown>)[key]);
    const schema = declaredSchemas[key];
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get() {
        recordRead(key);
        return shadow.get(key);
      },
      set(value: unknown) {
        if (schema) {
          const result = schema.safeParse(value);
          if (!result.success) {
            // Thrown *before* `recordWrite` — an invalid write must never
            // appear in `receipt.world.writes` (findings Q1's bug,
            // regularized into this module's own contract).
            throw new WorldWriteValidationError(key, formatValidationIssues(result.error.issues));
          }
          value = result.data;
        }
        shadow.set(key, value);
        recordWrite(key);
      },
    });
    instrumented.add(key);
  }

  function reconcile(): void {
    const keys = new Set<string>(Object.keys(target));
    for (const key of Object.keys(declaredSchemas)) keys.add(key);
    for (const key of keys) {
      if (instrumented.has(key)) continue;
      if (RESERVED_WORLD_KEYS.has(key)) {
        // Checked *before* the own-method skip below on purpose:
        // `attach`/`log`/`link` hold function *values* (cucumber-js's own
        // World shape — a callback, not a class method), so
        // `isOwnPlainDataKey` would otherwise call them "an existing own
        // method" and skip wrapping them, leaving them writable forever.
        // Reserved-key protection must apply regardless of what shape the
        // key's current value happens to be.
        defineReserved(key);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(target, key) && !isOwnPlainDataKey(target, key)) {
        // An existing own method/accessor under this name (rare — e.g. an
        // arrow-function-valued class field) — never clobbered.
        continue;
      }
      defineMeasured(key);
    }
  }

  // Initial seed: own keys at wrap time ∪ declared keys (findings' hole-2
  // fix) — run through the exact same function `beginStep()` calls later,
  // so "wrap" and "reconcile" are one mechanism, not two.
  reconcile();

  return {
    beginStep(): void {
      reconcile();
      reads = [];
      readsSeen = new Set();
      writes = [];
      writesSeen = new Set();
    },
    snapshot(): WorldReadsWrites {
      return { reads: [...reads], writes: [...writes] };
    },
  };
}
