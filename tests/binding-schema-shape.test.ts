import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asObjectShape, classifyPrimitive, isRequiredField } from "../src/binding/schema-shape.js";

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
});
