import type { z } from "zod";

// Responsibility: the one place that turns a step's declared `args` schema
// into the schema every execution path's `safeParse` actually runs, so the
// parse agrees with the JSON Schema `nuka describe` publishes for that same
// schema (`z.toJSONSchema`). A plain `z.object(...)` is published as
// `additionalProperties: false`, but zod's own default parse mode for an
// unrecognized key is "strip", not "reject", so the runtime used to accept
// (and a step record could carry) a key the published contract already said
// was refused. `.strict()` closes that gap for the plain object a
// `defineStep` author gets from `z.object(...)`, rather than asking each of
// them to write `.strict()` themselves. Every execution path that turns a
// step's `args` into a validated value calls this first.
//
// A schema that already carries a catchall is left alone. `z.looseObject`,
// `.passthrough()`, and `.catchall(...)` set `_zod.def.catchall`, and
// `z.toJSONSchema` publishes that choice: `additionalProperties` of `{}`,
// or of the catchall's own schema. `.strict()` replaces whatever catchall
// is there with `z.never()`, which would refuse a key the published
// contract allows. A plain object leaves `catchall` unset, which is the
// only case strictified here. `z.strictObject` and `.strict()` already set
// the catchall to `z.never()`, so they stay strict without another pass.
//
// Only a schema that is directly a `z.object(...)` is considered: every
// `args` schema in this codebase is written that way. A schema wrapped in
// `.optional()`/`.default()` around the object, or one that isn't an object
// at all (a CLI-only step with no pattern is allowed non-object args.
// src/check/binding-check.ts's own `args-not-object` finding only fires for
// a step with a pattern), is returned unchanged. Unwrapping and rewrapping
// would need to reconstruct the original wrapper (a `.default(...)` schema
// only exposes its default value through zod's internal `def`, not a public
// accessor), and no step in this codebase needs it.
export function strictArgsSchema<T extends z.ZodTypeAny>(schema: T): T {
  if (schema.type !== "object") return schema;
  const objectSchema = schema as unknown as z.ZodObject;
  if (objectSchema._zod.def.catchall !== undefined) return schema;
  return objectSchema.strict() as unknown as T;
}
