import type { z } from "zod";

// Responsibility: the "only flag a definite mismatch" static reading of a
// step's `args` zod schema — unwrap the
// optional/default wrappers a schema author commonly puts around a key,
// then answer three narrow questions: is this schema even a `z.object`
// (pattern-bound steps must be), what does a given key's declared type
// definitely coerce to (number, string, or "can't tell"), and is a given
// key required (not optional, no default). Deliberately does *not* attempt
// a full structural comparison — a union, a custom refinement, or any other
// schema this module can't classify with certainty is left alone; check's
// own job is to not be overzealous (docs/spec.md "Typed steps": the runtime
// zod parse in `do`/`run` is the last line of defense).

type Unwrappable = z.ZodTypeAny & { unwrap(): z.ZodTypeAny };

function isUnwrappable(schema: z.ZodTypeAny): schema is Unwrappable {
  return schema.type === "optional" || schema.type === "default";
}

/** Strips `.optional()`/`.default(...)` wrappers, repeatedly (a schema can
 * chain both, e.g. `.optional().default(...)`), leaving whatever schema
 * actually constrains the value once it's present. */
function unwrapOptionalDefault(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (isUnwrappable(current)) {
    current = current.unwrap();
  }
  return current;
}

/**
 * `undefined` unless `schema` (after unwrapping optional/default) is a
 * `z.object`, in which case its `.shape` — key
 * inspection goes through zod 4's `.shape`.
 */
export function asObjectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | undefined {
  const unwrapped = unwrapOptionalDefault(schema);
  if (unwrapped.type !== "object") {
    return undefined;
  }
  return (unwrapped as unknown as z.ZodObject).shape;
}

export type PrimitiveClass = "number" | "string" | "other";

/** Classifies what a schema field (after unwrapping optional/default)
 * definitely accepts, for the two coercions cucumber-expressions performs
 * (`{int}`/`{float}` -> number,
 * `{string}`/`{word}` -> string). Anything else — boolean, bigint, object,
 * array, union, any, unknown, a transform, ... — is "other": not
 * necessarily wrong, just not something this narrow check can be certain
 * about either way. */
export function classifyPrimitive(schema: z.ZodTypeAny): PrimitiveClass {
  const unwrapped = unwrapOptionalDefault(schema);
  if (unwrapped.type === "number") {
    return "number";
  }
  if (unwrapped.type === "string") {
    return "string";
  }
  return "other";
}

/** A field is "required" — must be supplied by *something* (a named
 * capture, or the one table/docstring attachment a pickle step may carry) —
 * when it isn't wrapped in `.optional()`/`.default()` at its own
 * declaration; those are the two zod wrappers that let a key be omitted
 * from the parsed input entirely. */
export function isRequiredField(schema: z.ZodTypeAny): boolean {
  return schema.type !== "optional" && schema.type !== "default";
}
