import type { z } from "zod";

// Responsibility: the "only flag a definite mismatch" static reading of a
// step's `args` zod schema — unwrap the
// optional/default wrappers a schema author commonly puts around a key,
// then answer three narrow questions: is this schema even a `z.object`
// (pattern-bound steps must be), what primitive a given key definitely is
// (number, string, or "can't tell"), and is a given
// key required (an object that declares it rejects a missing key). Deliberately does *not* attempt
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

/**
 * True when the schema converts its input before checking the declared
 * type. `z.coerce.number()` and `z.coerce.string()` set `def.coerce`
 * while leaving `type` as `"number"` or `"string"`. Reading only `type`
 * treats a schema the run accepts as a definite mismatch. `coerce` is
 * optional and is not on zod's base def type.
 */
function schemaCoerces(schema: z.ZodTypeAny): boolean {
  return (schema.def as { coerce?: unknown }).coerce === true;
}

/** Classifies what a schema field (after unwrapping optional/default)
 * definitely accepts, for the two coercions cucumber-expressions performs
 * (`{int}`/`{float}` -> number,
 * `{string}`/`{word}` -> string). Anything else (boolean, bigint, object,
 * array, union, any, unknown, a transform, or a schema that itself coerces
 * the captured value) is "other": not necessarily wrong, just not
 * something this narrow check can be certain about either way. Coercion is
 * read after optional/default unwrapping, because those wrappers do not
 * carry the flag. */
export function classifyPrimitive(schema: z.ZodTypeAny): PrimitiveClass {
  const unwrapped = unwrapOptionalDefault(schema);
  if (schemaCoerces(unwrapped)) {
    return "other";
  }
  if (unwrapped.type === "number") {
    return "number";
  }
  if (unwrapped.type === "string") {
    return "string";
  }
  return "other";
}

/** A field is required when an object that declares it rejects `{}`.
 *
 * Zod records "this key may be absent from the input" as
 * `_zod.optin === "optional"`. `.optional()`, `.default()`, `.prefault()`,
 * and `.catch()` set that flag, and so does a wrapper (readonly, lazy, pipe,
 * preprocess) whose input side does. `schema.type` only names the outer
 * constructor, so a catch or a readonly optional used to look required.
 *
 * The flag is not sufficient. A pipe whose input is optional and whose
 * output is not (`z.preprocess((value) => value, z.string())`,
 * `z.pipe(z.string().optional(), z.string())`) still rejects a missing key.
 * The object parser ignores a failed read of an absent key only when the
 * output is optional too (`_zod.optout === "optional"`). Otherwise the key
 * is required exactly when parsing `undefined` fails.
 *
 * `isOptional()` answers neither question. It is `safeParse(undefined).success`,
 * which is true for `z.any()`, `z.unknown()`, and `z.undefined()`, and an
 * object still rejects a missing key for each of those.
 *
 * A sync parse that throws (an async transform, a catch or default that
 * throws) is not a validation failure. This only claims a key is required
 * when omission fails validation, so a throw is not that claim. */
export function isRequiredField(schema: z.ZodTypeAny): boolean {
  if (schema._zod.optin !== "optional") {
    return true;
  }
  if (schema._zod.optout === "optional") {
    return false;
  }
  try {
    return !schema.safeParse(undefined).success;
  } catch {
    return false;
  }
}
