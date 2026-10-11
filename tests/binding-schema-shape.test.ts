import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { z } from "zod";
import { asObjectShape, classifyPrimitive, isRequiredField } from "../src/binding/schema-shape.js";

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
    expect(classifyPrimitive(z.boolean())).toBe("other");
    expect(classifyPrimitive(z.union([z.string(), z.number()]))).toBe("other");
    expect(classifyPrimitive(z.unknown())).toBe("other");
    expect(classifyPrimitive(z.object({}))).toBe("other");
  });
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
