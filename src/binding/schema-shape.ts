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

export type PrimitiveClass = "number" | "string" | "boolean" | "bigint" | "other";

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
 * definitely accepts, as the JS type of a value cucumber-expressions hands
 * over: number, string, boolean, or bigint. A pipe is read through its input
 * side, because that side parses the captured value first (a transform on the
 * output side cannot rescue a wrong input). Anything else (object, array,
 * union, any, unknown, a preprocess, or a schema that itself coerces the
 * captured value) is "other": not necessarily wrong, just not something this
 * narrow check can be certain about either way. Coercion is read after
 * optional/default unwrapping, because those wrappers do not carry the flag. */
export function classifyPrimitive(schema: z.ZodTypeAny): PrimitiveClass {
  const unwrapped = unwrapOptionalDefault(schema);
  if (schemaCoerces(unwrapped)) {
    return "other";
  }
  switch (unwrapped.type) {
    case "number":
    case "string":
    case "boolean":
    case "bigint":
      return unwrapped.type;
    case "pipe":
      return classifyPrimitive((unwrapped.def as unknown as { in: z.ZodTypeAny }).in);
    default:
      return "other";
  }
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

/** The required args keys that `consumed` (pattern captures plus `from`
 * keys) does not speak for. A table or docstring fills a step's args only
 * when exactly one such key remains; check, run, and the unfillable-key
 * check all ask this one question so they cannot disagree. */
export function unconsumedRequiredKeys(
  shape: Readonly<Record<string, z.ZodTypeAny>>,
  consumed: ReadonlySet<string>,
): string[] {
  return Object.entries(shape)
    .filter(([key, fieldSchema]) => !consumed.has(key) && isRequiredField(fieldSchema))
    .map(([key]) => key);
}

interface RewriteDef {
  readonly type: string;
  readonly coerce?: unknown;
  readonly checks?: readonly { readonly _zod: { readonly def: { readonly check?: unknown } } }[];
  readonly in?: z.ZodTypeAny;
  readonly out?: z.ZodTypeAny;
  readonly innerType?: z.ZodTypeAny;
  readonly getter?: () => z.ZodTypeAny;
  readonly shape?: Record<string, z.ZodTypeAny>;
  readonly catchall?: z.ZodTypeAny;
  readonly element?: z.ZodTypeAny;
  readonly items?: readonly z.ZodTypeAny[];
  readonly rest?: z.ZodTypeAny | null;
  readonly options?: readonly z.ZodTypeAny[];
  readonly left?: z.ZodTypeAny;
  readonly right?: z.ZodTypeAny;
  readonly keyType?: z.ZodTypeAny;
  readonly valueType?: z.ZodTypeAny;
}

/**
 * What, inside `schema`, makes the parsed value differ from the value it
 * was given, as words a refusal can name, or `null` when the schema only
 * checks its input and hands it on unchanged. A claim compares the value a
 * line states or an earlier step returned; a schema that rewrites that
 * value would let step code decide what the claim compares. Rewriting is
 * `z.coerce`, a transform, a preprocess, any other pipe (a codec, `.pipe`),
 * an overwrite check (`trim`, `toLowerCase`, `toUpperCase`, `normalize`,
 * `overwrite`), and `catch`, which replaces a value that failed. A refine
 * only checks, so it is not one. The walk goes through every wrapper and
 * container zod 4 has, and a lazy schema is read once. Pure.
 */
export function schemaRewrite(schema: z.ZodTypeAny): string | null {
  const seen = new Set<unknown>();
  const visit = (current: z.ZodTypeAny | null | undefined): string | null => {
    if (current === null || current === undefined || seen.has(current)) return null;
    seen.add(current);
    const def = current._zod.def as unknown as RewriteDef;
    if (def.coerce === true) return "z.coerce";
    if ((def.checks ?? []).some((check) => check._zod.def.check === "overwrite")) {
      return "an overwrite check (trim, toLowerCase, toUpperCase, normalize, or overwrite)";
    }
    switch (def.type) {
      case "transform":
        return "a transform";
      case "pipe": {
        if (def.in?._zod.def.type === "transform") return "a preprocess";
        if (def.out?._zod.def.type === "transform") return "a transform";
        return "a pipe";
      }
      case "catch":
        return "catch";
      case "lazy":
        return visit(def.getter?.());
      case "object":
        for (const field of Object.values(def.shape ?? {})) {
          const found = visit(field);
          if (found !== null) return found;
        }
        return visit(def.catchall);
      case "tuple":
        for (const item of def.items ?? []) {
          const found = visit(item);
          if (found !== null) return found;
        }
        return visit(def.rest);
      case "union":
        for (const option of def.options ?? []) {
          const found = visit(option);
          if (found !== null) return found;
        }
        return null;
      case "intersection":
        return visit(def.left) ?? visit(def.right);
      case "record":
      case "map":
        return visit(def.keyType) ?? visit(def.valueType);
      default:
        return visit(def.innerType) ?? visit(def.element) ?? visit(def.valueType);
    }
  };
  return visit(schema);
}

/** True when `schema`, after optional and default, is a `z.string()` that
 * does not coerce: the one schema `expected_view` can read, since a view
 * reads text. Pure. */
export function isPlainString(schema: z.ZodTypeAny): boolean {
  const unwrapped = unwrapOptionalDefault(schema);
  return unwrapped.type === "string" && !schemaCoerces(unwrapped);
}
