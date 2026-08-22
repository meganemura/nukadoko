import type { z } from "zod";

// Responsibility: the one place that turns a step's declared `args` schema
// into the schema every execution path's `safeParse` actually runs, closing
// a gap between what `nuka describe` publishes and what running a step
// enforced. `z.toJSONSchema` renders a plain `z.object(...)` as
// `additionalProperties: false` regardless of how it is later parsed, but a
// zod object's own default parse mode for an unrecognized key is "strip",
// not "reject" — so the runtime accepted (and, worse, a step record could
// carry) a key the published contract already said was refused. `.strict()`
// makes the parse mode match the contract every `defineStep` author already
// gets for free from `z.object(...)`, rather than asking each of them to
// write `.strict()` themselves — every execution path that turns a step's
// `args` into a validated value calls this first instead.
//
// Only a schema that is *directly* a `z.object(...)` is strictified: every
// `args` schema in this codebase is written that way. A schema wrapped in
// `.optional()`/`.default()` around the object, or one that isn't an object
// at all (a CLI-only step with no pattern is allowed non-object args —
// src/check/binding-check.ts's own `args-not-object` finding only fires for
// a step with a pattern), is returned unchanged: unwrapping and rewrapping
// would need to reconstruct the original wrapper (a `.default(...)` schema
// only exposes its default value through zod's internal `def`, not a public
// accessor), and no step in this codebase needs it.
export function strictArgsSchema<T extends z.ZodTypeAny>(schema: T): T {
  if (schema.type === "object") {
    return (schema as unknown as z.ZodObject).strict() as unknown as T;
  }
  return schema;
}
