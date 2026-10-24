import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { z } from "zod";
import { argsSchemaRewrite, asObjectShape, classifyPrimitive, isRequiredField, schemaRewrite } from "../src/binding/schema-shape.js";

// A key is required when an object that declares it rejects `{}`. That is
// the question `nuka check` and `nuka run` ask before they refuse a line.
// `schema.isOptional()` is a different question: it is true for `z.any()`,
// `z.unknown()`, and `z.undefined()`, and an object still rejects a missing
// key for each of those.
function omissionFails(schema: z.ZodTypeAny): boolean {
  const parsed = z.object({ key: schema }).safeParse({});
  return !parsed.success;
}

const fieldBases: readonly z.ZodTypeAny[] = [
  z.string(),
  z.number(),
  z.boolean(),
  z.enum(["fast", "slow"]),
  z.any(),
  z.unknown(),
  z.undefined(),
  z.null(),
  z.literal("a"),
];

// Each arm has to construct for every base above. A fallback of `"none"` is
// often the wrong value on purpose: `.prefault("none")` on `z.number()`
// still rejects a missing key, and the property has to keep saying so.
function applyWrap(schema: z.ZodTypeAny, kind: number): z.ZodTypeAny {
  switch (kind) {
    case 0:
      return schema.optional();
    case 1:
      return schema.nullable();
    case 2:
      return schema.nullish();
    case 3:
      return schema.readonly();
    case 4:
      return z.lazy(() => schema);
    case 5:
      return schema.catch(() => "none" as never);
    case 6:
      return schema.default("none" as never);
    case 7:
      return schema.prefault("none" as never);
    case 8:
      return schema.optional().transform((value) => value);
    case 9:
      return z.preprocess((value) => value, schema);
    case 10:
      return z.pipe(schema, schema);
    case 11:
      return schema.describe("note");
    case 12:
      return schema.exactOptional();
    case 13:
      return schema.nonoptional();
    case 14:
      return z.union([schema, z.string().optional()]);
    default:
      return schema;
  }
}

describe("asObjectShape", () => {
  it("returns the shape of a plain z.object", () => {
    const schema = z.object({ name: z.string() });
    expect(asObjectShape(schema)).toBe(schema.shape);
  });

  it("unwraps a top-level optional/default before checking", () => {
    const schema = z.object({ name: z.string() });
    expect(asObjectShape(schema.optional())).toBe(schema.shape);
    expect(asObjectShape(schema.default({ name: "x" }))).toBe(schema.shape);
  });

  it("returns undefined for a non-object schema", () => {
    expect(asObjectShape(z.string())).toBeUndefined();
    expect(asObjectShape(z.array(z.string()))).toBeUndefined();
  });
});

describe("classifyPrimitive", () => {
  it("classifies z.string() as string", () => {
    expect(classifyPrimitive(z.string())).toBe("string");
  });

  it("classifies z.number() as number", () => {
    expect(classifyPrimitive(z.number())).toBe("number");
  });

  it("unwraps optional/default before classifying", () => {
    expect(classifyPrimitive(z.number().optional())).toBe("number");
    expect(classifyPrimitive(z.string().default("x"))).toBe("string");
  });

  it("classifies anything else as other, including combinators it can't be certain about", () => {
    expect(classifyPrimitive(z.union([z.string(), z.number()]))).toBe("other");
    expect(classifyPrimitive(z.unknown())).toBe("other");
    expect(classifyPrimitive(z.object({}))).toBe("other");
  });

  it("classifies boolean and bigint", () => {
    expect(classifyPrimitive(z.boolean())).toBe("boolean");
    expect(classifyPrimitive(z.bigint().optional())).toBe("bigint");
  });

  it("reads a pipe through its input side", () => {
    expect(classifyPrimitive(z.string().transform((value) => value.length))).toBe("string");
    expect(classifyPrimitive(z.number().pipe(z.coerce.string()))).toBe("number");
    expect(classifyPrimitive(z.string().transform((value) => value.length).optional())).toBe("string");
  });

  it("classifies a pipe as other when its input coerces or is a preprocess", () => {
    expect(classifyPrimitive(z.coerce.string().pipe(z.string()))).toBe("other");
    expect(classifyPrimitive(z.preprocess((value) => String(value), z.string()))).toBe("other");
  });

  it("classifies a coercing number or string as other, with or without optional or default", () =>
    hegel.test((tc) => {
      const numeric = tc.draw(gs.booleans());
      const coerce = tc.draw(gs.booleans());
      const wrap = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
      let schema: z.ZodTypeAny = numeric
        ? coerce
          ? z.coerce.number()
          : z.number()
        : coerce
          ? z.coerce.string()
          : z.string();
      if (wrap === 1) {
        schema = schema.optional();
      } else if (wrap === 2) {
        schema = numeric ? schema.default(0) : schema.default("x");
      }
      expect(classifyPrimitive(schema)).toBe(coerce ? "other" : numeric ? "number" : "string");
    }));
});

describe("isRequiredField", () => {
  it("is true for a plain field", () => {
    expect(isRequiredField(z.string())).toBe(true);
  });

  it("is false for an optional or defaulted field", () => {
    expect(isRequiredField(z.string().optional())).toBe(false);
    expect(isRequiredField(z.string().default("x"))).toBe(false);
  });

  it("is false when zod accepts a missing key", () => {
    expect(isRequiredField(z.string().catch("none"))).toBe(false);
    expect(isRequiredField(z.string().prefault("none"))).toBe(false);
    expect(isRequiredField(z.string().optional().transform((value) => value ?? "none"))).toBe(false);
    expect(isRequiredField(z.preprocess((value) => value, z.string().optional()))).toBe(false);
    expect(isRequiredField(z.lazy(() => z.string().optional()))).toBe(false);
    expect(isRequiredField(z.string().optional().readonly())).toBe(false);
    expect(isRequiredField(z.enum(["fast", "slow"]).catch("fast"))).toBe(false);
    expect(isRequiredField(z.string().exactOptional())).toBe(false);
  });

  it("does not throw when parsing a missing key throws", () => {
    const throwing = z.string().catch(() => {
      throw new Error("boom");
    });
    expect(isRequiredField(throwing)).toBe(false);
  });

  it("is true when omitting the key fails validation", () => {
    expect(isRequiredField(z.string())).toBe(true);
    expect(isRequiredField(z.any())).toBe(true);
    expect(isRequiredField(z.unknown())).toBe(true);
    expect(isRequiredField(z.undefined())).toBe(true);
    expect(isRequiredField(z.string().nullable())).toBe(true);
    expect(isRequiredField(z.preprocess((value) => value, z.string()))).toBe(true);
    expect(isRequiredField(z.pipe(z.string().optional(), z.string()))).toBe(true);
    expect(isRequiredField(z.number().prefault("nope" as never))).toBe(true);
    expect(isRequiredField(z.string().optional().nonoptional())).toBe(true);
  });

  it("agrees with object omission for wrapped fields", () =>
    hegel.test((tc) => {
      const base = fieldBases[tc.draw(gs.integers({ minValue: 0, maxValue: fieldBases.length - 1 }))]!;
      const kinds = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 14 }), { minSize: 0, maxSize: 4 }));
      let schema = base;
      for (const kind of kinds) {
        schema = applyWrap(schema, kind);
      }
      expect(isRequiredField(schema)).toBe(omissionFails(schema));
    }));
});

// A claim compares the value a line states or an earlier step returned, so
// `schemaRewrite` has to find a rewrite wherever a schema hides it, and has
// to find nothing in a schema that only checks. The schemas below nest a
// leaf in the wrappers and containers a step file uses.
const checkingLeaves: readonly (() => z.ZodTypeAny)[] = [
  () => z.string(),
  () => z.number().int(),
  () => z.boolean(),
  () => z.null(),
  () => z.string().refine((text) => text.length < 100),
  () => z.enum(["a", "b"]),
  () => z.array(z.string()).min(1),
];

const DEFAULT_WORDS = "a default (default or prefault), which fills a value that is missing";
const REFINE_WORDS = "a refine, superRefine, or check on an object or an array, which can change the value it is handed";

const rewritingLeaves: readonly (readonly [() => z.ZodTypeAny, string])[] = [
  [() => z.number().transform((n) => n + 1), "a transform"],
  [() => z.coerce.number(), "z.coerce"],
  [() => z.preprocess((value) => value, z.string()), "a preprocess"],
  [() => z.string().pipe(z.string()), "a pipe"],
  [() => z.string().trim(), "an overwrite check (trim, toLowerCase, toUpperCase, normalize, or overwrite)"],
  [() => z.string().toLowerCase(), "an overwrite check (trim, toLowerCase, toUpperCase, normalize, or overwrite)"],
  [() => z.string().catch("x"), "catch"],
  [() => z.number().default(3), DEFAULT_WORDS],
  [() => z.number().prefault(3), DEFAULT_WORDS],
  [() => z.object({ count: z.number() }).refine(() => true), REFINE_WORDS],
  [() => z.object({ count: z.number() }).superRefine(() => {}), REFINE_WORDS],
  [() => z.array(z.number()).check(() => {}), REFINE_WORDS],
  [() => z.object({ count: z.number() }).overwrite((value) => value), "an overwrite check (trim, toLowerCase, toUpperCase, normalize, or overwrite)"],
];

type Container = "optional" | "nullable" | "readonly" | "array" | "object" | "union" | "tuple" | "lazy" | "record" | "intersection";
const containers: readonly Container[] = ["optional", "nullable", "readonly", "array", "object", "union", "tuple", "lazy", "record", "intersection"];

function contain(inner: z.ZodTypeAny, kind: Container, sibling: z.ZodTypeAny): z.ZodTypeAny {
  switch (kind) {
    case "optional":
      return inner.optional();
    case "nullable":
      return inner.nullable();
    case "readonly":
      return inner.readonly();
    case "array":
      return z.array(inner);
    case "object":
      return z.object({ other: sibling, key: inner });
    case "union":
      return z.union([sibling, inner]);
    case "tuple":
      return z.tuple([sibling, inner]);
    case "lazy":
      return z.lazy(() => inner);
    case "record":
      return z.record(z.string(), inner);
    case "intersection":
      return z.intersection(z.object({ a: sibling }), z.object({ b: inner }));
  }
}

describe("schemaRewrite", () => {
  it("finds nothing in a schema that only checks, however it is nested", () =>
    hegel.test((tc) => {
      let schema = tc.draw(gs.sampledFrom(checkingLeaves))();
      for (const kind of tc.draw(gs.arrays(gs.sampledFrom(containers), { maxSize: 4 }))) {
        schema = contain(schema, kind, tc.draw(gs.sampledFrom(checkingLeaves))());
      }
      expect(schemaRewrite(schema)).toBeNull();
    }));

  it("finds a rewrite anywhere inside, and names it", () =>
    hegel.test((tc) => {
      const [leaf, words] = tc.draw(gs.sampledFrom(rewritingLeaves));
      let schema = leaf();
      for (const kind of tc.draw(gs.arrays(gs.sampledFrom(containers), { maxSize: 4 }))) {
        schema = contain(schema, kind, tc.draw(gs.sampledFrom(checkingLeaves))());
      }
      expect(schemaRewrite(schema)).toBe(words);
    }));
});

describe("argsSchemaRewrite", () => {
  const ROOT_REFINE = "a refine, superRefine, or check on the args object, which can change the value it is handed";
  const fields = { code: z.number(), cart: z.object({ count: z.number() }) };

  it("finds a refine, a superRefine, a check, an overwrite, or a default on the args object itself", () => {
    expect(argsSchemaRewrite(z.object(fields).refine(() => true))).toBe(ROOT_REFINE);
    expect(argsSchemaRewrite(z.object(fields).superRefine(() => {}))).toBe(ROOT_REFINE);
    expect(argsSchemaRewrite(z.object(fields).check(() => {}))).toBe(ROOT_REFINE);
    expect(argsSchemaRewrite(z.object(fields).overwrite((value) => value))).toBe("an overwrite check (trim, toLowerCase, toUpperCase, normalize, or overwrite)");
    expect(argsSchemaRewrite(z.object(fields).default({ code: 1, cart: { count: 1 } }))).toBe(DEFAULT_WORDS);
    expect(argsSchemaRewrite(z.object(fields).refine(() => true).optional())).toBe(ROOT_REFINE);
  });

  it("leaves the keys to schemaRewrite: a rewrite inside one key is not the args object's", () =>
    hegel.test((tc) => {
      const [leaf] = tc.draw(gs.sampledFrom(rewritingLeaves));
      expect(argsSchemaRewrite(z.object({ code: z.number(), key: leaf() }))).toBeNull();
    }));
});
