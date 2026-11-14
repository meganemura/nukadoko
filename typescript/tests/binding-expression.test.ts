import { describe, expect, it } from "vitest";
import { buildExpression } from "../src/binding/expression.js";
import { UnnamedCaptureError } from "../src/binding/errors.js";
import { ParameterTypeCollisionError } from "../src/binding/parameter-type-errors.js";
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

  it("registers a custom parameterTypes entry, transformer and all", () => {
    const registry = createParameterTypeRegistry([
      { name: "negation", regexp: /( not)?/, transformer: (s: string) => s === " not" },
    ]);
    const parameterType = registry.lookupByTypeName("negation");
    expect(parameterType).toBeDefined();
    expect(parameterType?.transform(null, [" not"])).toBe(true);
    expect(parameterType?.transform(null, [undefined as unknown as string])).toBe(false);
  });

  it("defaults an omitted transformer to the matched string as-is", () => {
    const registry = createParameterTypeRegistry([{ name: "loud", regexp: "[A-Z]+" }]);
    expect(registry.lookupByTypeName("loud")?.transform(null, ["YES"])).toBe("YES");
  });

  it("throws ParameterTypeCollisionError('built-in') for a name that collides with int/float/word/string", () => {
    expect(() => createParameterTypeRegistry([{ name: "int", regexp: /x/ }])).toThrow(
      ParameterTypeCollisionError,
    );
    let caught: unknown;
    try {
      createParameterTypeRegistry([{ name: "int", regexp: /x/ }]);
    } catch (error) {
      caught = error;
    }
    expect((caught as ParameterTypeCollisionError).reason).toBe("built-in");
    expect((caught as ParameterTypeCollisionError).typeName).toBe("int");
    expect((caught as ParameterTypeCollisionError).message).toContain(
      "quietly change the meaning",
    );
  });

  it("throws ParameterTypeCollisionError('duplicate') for two custom entries sharing a name", () => {
    let caught: unknown;
    try {
      createParameterTypeRegistry([
        { name: "negation", regexp: /a/ },
        { name: "negation", regexp: /b/ },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ParameterTypeCollisionError);
    expect((caught as ParameterTypeCollisionError).reason).toBe("duplicate");
  });

  it("names the anonymous parameter type when a preferred type takes its regexp", () => {
    expect(() => createParameterTypeRegistry([{ name: "anything", regexp: /.*/, preferForRegexpMatch: true }])).toThrow(
      'Custom parameter type "anything" sets preferForRegexpMatch on /.*/, which the anonymous parameter type already prefers: only one parameter type can be preferred for a regexp, so set preferForRegexpMatch on one of them',
    );
  });

  it("treats a truthy non-boolean preferForRegexpMatch as set, as cucumber-expressions does", () => {
    expect(() =>
      createParameterTypeRegistry([
        { name: "codeA", regexp: /[A-Z]+/, preferForRegexpMatch: true },
        { name: "codeB", regexp: /[A-Z]+/, preferForRegexpMatch: 1 as unknown as boolean },
      ]),
    ).toThrow(
      'Custom parameter type "codeB" sets preferForRegexpMatch on /[A-Z]+/, which {codeA} already prefers: only one parameter type can be preferred for a regexp, so set preferForRegexpMatch on one of them',
    );
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
