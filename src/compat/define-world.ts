import type { z } from "zod";
import { ReservedWorldKeyDeclaredError } from "./errors.js";
import { RESERVED_WORLD_KEYS } from "./world-instrumentation.js";
import { World, type WorldConstructorParams } from "./world.js";

// Responsibility: the `defineWorld(schemas)` registration API (m2c-typed-
// world task spec, item 2) — declares which World keys are validated at
// write time and (see below) attempts to carry that shape into TypeScript's
// own `this` typing for compat glue. Registration only; the buffer this
// module owns is read exactly once per discovery run by
// src/discover/discover-steps.ts, the same buffer/drain shape
// src/compat/registry.ts's `defineParameterType` already uses (this file's
// buffer is an array for the same reason: it lets discovery attribute a
// second `defineWorld` call — anywhere, including twice in the same file —
// to the file(s) that made it, instead of silently overwriting one
// registration with another).
//
// The actual runtime enforcement (validate-before-record, reserved-key
// protection) lives in src/compat/world-instrumentation.ts, applied by
// src/compat/world.ts's `instantiateWorldForPickle` once per pickle; this
// module never touches a World *instance*, only the schema *declaration*.
//
// TS typing attempt (task spec item 4): `defineWorld` returns the real
// `World` class itself, cast to a constructor type whose instances carry
// `InferWorldFields<S>` — so `class MyWorld extends defineWorld({ listing:
// z.object({...}).optional() }) {}` makes `this.listing` type-check inside
// compat glue (`this: MyWorld`) with no interface written by hand. This
// works *because* `defineWorld` returns `World` itself (not a new class):
// `class MyWorld extends defineWorld(schemas) {}` is, after erasure,
// exactly `class MyWorld extends World {}` — same prototype chain, same
// constructor, same `openPage`/`page` etc. — so nothing about the runtime
// path (`setWorldConstructor`, `instantiateWorldForPickle`) has to change
// to accommodate it. The cast is unsound in the narrow sense that nothing
// stops a caller from lying about `S`, but that is true of every other
// runtime-validated boundary in this codebase (a step's own `args`/
// `returns` schema is the actual trust anchor, not the type) — TypeScript
// here documents the declared shape; the zod schema is what actually
// enforces it, on every write, regardless of what a caller claims when
// extending.
export type InferWorldFields<S extends Record<string, z.ZodTypeAny>> = {
  [K in keyof S]: z.infer<S[K]>;
};

export interface WorldSchemaRegistration {
  readonly schemas: Readonly<Record<string, z.ZodTypeAny>>;
  readonly registrationOrder: number;
}

let registrationBuffer: WorldSchemaRegistration[] = [];
let registrationCounter = 0;

/**
 * Registers this run's World field schemas once. `S`'s keys become both a
 * run-time zod-validated write path (src/compat/world-instrumentation.ts)
 * and, via this function's own return type, a `this` shape a custom World
 * subclass can extend into (see this file's header). Calling this more than
 * once — in one file or across files — is always an error
 * (src/discover/discover-steps.ts's `DuplicateWorldDefinitionError`); this
 * function itself only buffers, so that duplicate is detected, and
 * attributed to both files, by discovery reading this buffer back per file,
 * the same way two colliding compat step registrations are (src/compat/
 * registry.ts's own header explains why the buffer, not an immediate throw
 * here, is what makes that attribution possible).
 *
 * @throws {ReservedWorldKeyDeclaredError} `schemas` names `attach`/`log`/
 * `link`/`parameters` — the harness's own reserved World fields, never
 * user-declarable.
 */
export function defineWorld<S extends Record<string, z.ZodTypeAny>>(
  schemas: S,
): new (params: WorldConstructorParams) => World & InferWorldFields<S> {
  for (const key of Object.keys(schemas)) {
    if (RESERVED_WORLD_KEYS.has(key)) {
      throw new ReservedWorldKeyDeclaredError(key);
    }
  }
  registrationBuffer.push({ schemas, registrationOrder: registrationCounter++ });
  return World as unknown as new (
    params: WorldConstructorParams,
  ) => World & InferWorldFields<S>;
}

/**
 * Returns every `defineWorld` registration made since the last drain and
 * empties the buffer — read once per file by src/discover/discover-
 * steps.ts, immediately after importing it, mirroring
 * `drainCompatParameterTypes` (src/compat/registry.ts).
 */
export function drainWorldSchemaRegistrations(): WorldSchemaRegistration[] {
  const drained = registrationBuffer;
  registrationBuffer = [];
  return drained;
}
