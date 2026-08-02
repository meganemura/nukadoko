import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkBindings } from "../src/check/binding-check.js";
import { defineStep } from "../src/step/define-step.js";
import type { Vocabulary, VocabularyEntry } from "../src/discover/discover-steps.js";

function vocab(entries: Record<string, Extract<VocabularyEntry, { kind: "typed" }>["step"]>): Vocabulary {
  const map = new Map<string, VocabularyEntry>();
  for (const [name, step] of Object.entries(entries)) {
    map.set(name, { kind: "typed", name, filePath: `features/steps/${name}.ts`, step });
  }
  return map;
}

describe("checkBindings", () => {
  it("reports no issues for a well-formed pattern-bearing step", () => {
    const step = defineStep({
      pattern: "a project {name:string} exists",
      description: "d",
      args: z.object({ name: z.string() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const result = checkBindings(vocab({ "create-project": step }));
    expect(result.issues).toEqual([]);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0]?.stepName).toBe("create-project");
    expect(result.patterns[0]?.captures).toEqual([{ key: "name", type: "string" }]);
  });

  it("does not check CLI-only steps (no patterns) at all", () => {
    const step = defineStep({
      description: "no pattern",
      args: z.string(), // would be an args-not-object issue if patterns existed
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const result = checkBindings(vocab({ "list-projects": step }));
    expect(result.issues).toEqual([]);
    expect(result.patterns).toEqual([]);
  });

  it("flags a pattern-bearing step whose args isn't a z.object", () => {
    const step = defineStep({
      pattern: "a bare thing {value:string}",
      description: "d",
      args: z.string(),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const result = checkBindings(vocab({ "bare-thing": step }));
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "args-not-object", step: "bare-thing" }),
    ]);
  });

  it("flags an unnamed capture", () => {
    const step = defineStep({
      pattern: "an unnamed {string} thing",
      description: "d",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const result = checkBindings(vocab({ "unnamed-thing": step }));
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "unnamed-capture", step: "unnamed-thing" }),
    ]);
    expect(result.patterns).toEqual([]);
  });

  it("flags an unknown (unregistered) parameter type name", () => {
    const step = defineStep({
      pattern: "a {value:frobnicate} thing",
      description: "d",
      args: z.object({ value: z.string() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const result = checkBindings(vocab({ "frob-thing": step }));
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe("unknown-parameter-type");
    expect(result.issues[0]?.message).toContain("Undefined parameter type 'frobnicate'");
  });

  it("flags a captured key that isn't in the args schema", () => {
    const step = defineStep({
      pattern: "unknown key {oops:string} thing",
      description: "d",
      args: z.object({ other: z.string() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const result = checkBindings(vocab({ "unknown-key": step }));
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "unknown-capture-key", step: "unknown-key" }),
    ]);
  });

  it("flags a number-coercing capture bound to a string field", () => {
    const step = defineStep({
      pattern: "a count of {value:int}",
      description: "d",
      args: z.object({ value: z.string() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const result = checkBindings(vocab({ "count-step": step }));
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "capture-type-mismatch", step: "count-step" }),
    ]);
  });

  it("flags a string-coercing capture bound to a number field", () => {
    const step = defineStep({
      pattern: "a name of {value:string}",
      description: "d",
      args: z.object({ value: z.number() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const result = checkBindings(vocab({ "name-step": step }));
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "capture-type-mismatch", step: "name-step" }),
    ]);
  });

  it("does not flag a capture type it can't be certain about (e.g. bound to a union)", () => {
    const step = defineStep({
      pattern: "a flexible {value:string}",
      description: "d",
      args: z.object({ value: z.union([z.string(), z.number()]) }),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const result = checkBindings(vocab({ "flexible-step": step }));
    expect(result.issues).toEqual([]);
  });

  it("flags aliases that bind different key sets", () => {
    const step = defineStep({
      patterns: ["alias a {x:string}", "alias b {y:string}"],
      description: "d",
      args: z.object({ x: z.string(), y: z.string() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const result = checkBindings(vocab({ "alias-step": step }));
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "alias-key-mismatch", step: "alias-step" }),
    ]);
  });

  it("does not flag aliases that bind the same key set", () => {
    const step = defineStep({
      patterns: ["greet {name:string} formally", "say hello to {name:string}"],
      description: "d",
      args: z.object({ name: z.string() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const result = checkBindings(vocab({ "greet-step": step }));
    expect(result.issues).toEqual([]);
  });

  it("flags two different steps whose patterns normalize to the same text", () => {
    const stepA = defineStep({
      pattern: "duplicate text {a:string}",
      description: "d",
      args: z.object({ a: z.string() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const stepB = defineStep({
      pattern: "duplicate text {b:string}",
      description: "d",
      args: z.object({ b: z.string() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const result = checkBindings(vocab({ "duplicate-a": stepA, "duplicate-b": stepB }));
    expect(result.issues).toEqual([expect.objectContaining({ code: "duplicate-pattern" })]);
  });

  it("reports a single parameter-type-invalid issue (not per-pattern) when a custom type collides with a built-in", () => {
    const step = defineStep({
      pattern: "a {value:string} thing",
      description: "d",
      args: z.object({ value: z.string() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const result = checkBindings(vocab({ "some-step": step }), [
      { name: "int", regexp: /x/ },
    ]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "parameter-type-invalid" })]);
    expect(result.patterns).toEqual([]);
  });

  it("reports parameter-type-invalid for two config.parameterTypes entries sharing a name", () => {
    const step = defineStep({
      pattern: "a {value:string} thing",
      description: "d",
      args: z.object({ value: z.string() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const result = checkBindings(vocab({ "some-step": step }), [
      { name: "custom-a", regexp: /x/ },
      { name: "custom-a", regexp: /y/ },
    ]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "parameter-type-invalid" })]);
    expect(result.patterns).toEqual([]);
  });
});
