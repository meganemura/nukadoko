import { describe, expect, it } from "vitest";
import { buildExpression } from "../src/binding/expression.js";
import { UnnamedCaptureError } from "../src/binding/errors.js";
import { createParameterTypeRegistry } from "../src/binding/registry.js";

describe("createParameterTypeRegistry", () => {
  it("registers cucumber-expressions' built-in types and nothing custom", () => {
    const registry = createParameterTypeRegistry();
    expect(registry.lookupByTypeName("string")).toBeDefined();
    expect(registry.lookupByTypeName("int")).toBeDefined();
    expect(registry.lookupByTypeName("float")).toBeDefined();
    expect(registry.lookupByTypeName("word")).toBeDefined();
    expect(registry.lookupByTypeName("some-custom-type")).toBeUndefined();
  });
});

describe("buildExpression", () => {
  it("builds a matching expression from a named-capture pattern", () => {
    const registry = createParameterTypeRegistry();
    const bound = buildExpression("a project {name:string} exists", registry);

    expect(bound.captures).toEqual([{ key: "name", type: "string" }]);
    const args = bound.expression.match('a project "acme" exists');
    expect(args).not.toBeNull();
    expect(args?.[0]?.getValue(null)).toBe("acme");
  });

  it("returns null from the expression when the text doesn't match", () => {
    const registry = createParameterTypeRegistry();
    const bound = buildExpression("a project {name:string} exists", registry);
    expect(bound.expression.match("something else entirely")).toBeNull();
  });

  it("propagates a capture-naming error unchanged (no check-specific wrapping)", () => {
    const registry = createParameterTypeRegistry();
    expect(() => buildExpression("a project {string} exists", registry)).toThrow(UnnamedCaptureError);
  });

  it("propagates cucumber-expressions' own error for an unknown parameter type", () => {
    const registry = createParameterTypeRegistry();
    expect(() => buildExpression("a {value:frobnicate} thing", registry)).toThrow(
      /Undefined parameter type 'frobnicate'/,
    );
  });
});
