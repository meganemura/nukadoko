import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkBindings } from "../src/check/binding-check.js";
import { defineStep } from "../src/step/define-step.js";
import type {
  CompatParameterTypeEntry,
  Vocabulary,
  VocabularyEntry,
} from "../src/discover/discover-steps.js";

// Responsibility: tests/check-binding.test.ts already covers typed-step
// pattern errors that stripCaptureNames/CucumberExpression's own
// UndefinedParameterTypeError branch produce, plus config.parameterTypes
// collisions. This file covers the paths that one leaves untouched: an
// unterminated `{` capture, a cucumber-expression syntax error that is
// *not* an unknown parameter type (checkBindings' own
// expressionErrorToIssue fallback), a compat-origin parameter type name
// cucumber-expressions itself rejects (registry.ts's own re-throw when the
// underlying error isn't a ParameterTypeCollisionError), a compat string
// pattern with a syntax error, and two compat RegExp patterns sharing one
// expression.

function vocab(entries: Record<string, Extract<VocabularyEntry, { kind: "typed" }>["step"]>): Vocabulary {
  const map = new Map<string, VocabularyEntry>();
  for (const [name, step] of Object.entries(entries)) {
    map.set(name, { kind: "typed", name, filePath: `features/steps/${name}.ts`, step });
  }
  return map;
}

/** Builds a `Vocabulary` with one compat entry: a plain object literal
 * satisfying `CompatVocabularyEntry`'s own shape, the same "construct the
 * map directly" convention `vocab` above already follows for typed steps,
 * since checkBindings only ever reads this shape, never discovers it. */
function compatVocab(name: string, pattern: string | RegExp): Vocabulary {
  const map = new Map<string, VocabularyEntry>();
  map.set(name, {
    kind: "compat",
    name,
    filePath: "features/steps/legacy.ts",
    compat: {
      keyword: "Given",
      pattern,
      patternSource: typeof pattern === "string" ? pattern : pattern.toString(),
      fn: async () => undefined,
      registrationOrder: 0,
    },
  });
  return map;
}

describe("checkBindings: pattern-error paths tests/check-binding.test.ts doesn't reach", () => {
  it("flags an unterminated capture ('{' with no matching '}')", () => {
    const step = defineStep({
      pattern: "a thing {name",
      description: "d",
      args: z.object({ name: z.string() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const result = checkBindings(vocab({ "unterminated-thing": step }));
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "unterminated-capture", step: "unterminated-thing" }),
    ]);
    expect(result.patterns).toEqual([]);
  });

  it("flags a cucumber-expression syntax error that is not an unknown parameter type (an unmatched optional '(')", () => {
    const step = defineStep({
      pattern: "a (thing exists",
      description: "d",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const result = checkBindings(vocab({ "unbalanced-thing": step }));
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ code: "pattern-syntax-error", step: "unbalanced-thing" });
    // Never the unknown-parameter-type wording: a different failure mode
    // with its own code, handled by expressionErrorToIssue's other branch.
    expect(result.issues[0]?.message).not.toContain("registered parameter types are");
  });

  it("propagates (does not swallow as parameter-type-invalid) a compat-origin defineParameterType whose name cucumber-expressions itself rejects", () => {
    const step = defineStep({
      pattern: "a {value:string} thing",
      description: "d",
      args: z.object({ value: z.string() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    const badCompatType: CompatParameterTypeEntry = {
      name: "bad(name)",
      regexp: /x/,
      registrationOrder: 0,
      filePath: "features/steps/legacy.ts",
    };
    // Unlike a name collision (ParameterTypeCollisionError, caught and
    // reported as `parameter-type-invalid`), an illegal-for-cucumber-
    // expressions name throws a plain CucumberExpressionError checkBindings
    // does not recognize as its own, so it must reach the caller rather than
    // being reported as a normal check issue.
    expect(() => checkBindings(vocab({ "some-step": step }), [], [badCompatType])).toThrow();
  });

  it("flags a compat string pattern with a syntax error the same way a typed step's pattern would", () => {
    const result = checkBindings(compatVocab("compat: a (thing exists", "a (thing exists"));
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "pattern-syntax-error", step: "compat: a (thing exists" }),
    ]);
    expect(result.patterns).toEqual([]);
  });

  it("flags two compat RegExp patterns that are the same expression as duplicate-pattern", () => {
    const map = new Map<string, VocabularyEntry>();
    map.set("compat: /^same$/ (a)", {
      kind: "compat",
      name: "compat: /^same$/ (a)",
      filePath: "features/steps/legacy-a.ts",
      compat: {
        keyword: "Given",
        pattern: /^same$/,
        patternSource: "/^same$/",
        fn: async () => undefined,
        registrationOrder: 0,
      },
    });
    map.set("compat: /^same$/ (b)", {
      kind: "compat",
      name: "compat: /^same$/ (b)",
      filePath: "features/steps/legacy-b.ts",
      compat: {
        keyword: "Given",
        pattern: /^same$/,
        patternSource: "/^same$/",
        fn: async () => undefined,
        registrationOrder: 1,
      },
    });

    const result = checkBindings(map);
    expect(result.issues).toEqual([expect.objectContaining({ code: "duplicate-pattern" })]);
    expect(result.issues[0]?.message).toContain("compat RegExp");
  });
});
