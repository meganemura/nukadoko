import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Vocabulary, VocabularyEntry } from "../src/discover/discover-steps.js";
import { buildStepBindings, matchPickleStep } from "../src/run/match-step.js";
import { defineStep } from "../src/step/define-step.js";

// Responsibility: a compat RegExp step's captures are what the glue function
// receives. cucumber-js looks each group's source up in the parameter type
// registry, so `(\d+)` arrives as a number and an unmatched optional group
// arrives as null. A raw `RegExp.exec` string would make `n + 1` concatenate
// and still pass the step. Typed `{int}` stays on the cucumber-expression
// path; this file checks that path still returns a number too.

function compatVocabulary(pattern: RegExp): Vocabulary {
  const patternSource = pattern.toString();
  const name = `compat: ${patternSource}`;
  const entry: VocabularyEntry = {
    kind: "compat",
    name,
    filePath: "features/steps/legacy.ts",
    compat: {
      keyword: "Given",
      pattern,
      patternSource,
      fn() {
        return undefined;
      },
      registrationOrder: 0,
    },
  };
  return new Map([[name, entry]]);
}

function matchedValues(pattern: RegExp, text: string): readonly unknown[] {
  const outcome = matchPickleStep(text, buildStepBindings(compatVocabulary(pattern)));
  if (outcome.kind !== "matched") {
    throw new Error(`expected ${JSON.stringify(text)} to match ${pattern}, got ${outcome.kind}`);
  }
  return outcome.values;
}

describe("compat RegExp capture conversion", () => {
  it("gives a (\\d+) capture to the step as that number", () =>
    hegel.test((tc) => {
      const count = tc.draw(gs.integers({ minValue: 0, maxValue: Number.MAX_SAFE_INTEGER }));
      expect(matchedValues(/^I have (\d+) cukes$/, `I have ${count} cukes`)).toEqual([count]);
    }));

  it("gives a (-?\\d+) capture to the step as that number, including negatives", () =>
    hegel.test((tc) => {
      const count = tc.draw(
        gs.integers({ minValue: -Number.MAX_SAFE_INTEGER, maxValue: Number.MAX_SAFE_INTEGER }),
      );
      expect(matchedValues(/^I have (-?\d+) cukes$/, `I have ${count} cukes`)).toEqual([count]);
    }));

  it("receives the number 5 from (\\d+)", () => {
    expect(matchedValues(/^I have (\d+) cukes$/, "I have 5 cukes")).toEqual([5]);
  });

  it("receives null for an unmatched optional group", () => {
    expect(matchedValues(/^I have( \d+)? cukes$/, "I have cukes")).toEqual([null]);
  });

  it("leaves a group that matches no built-in type as a string", () => {
    expect(matchedValues(/^a ([a-z]+) item$/, "a red item")).toEqual(["red"]);
  });

  it("converts (\\d+) on every call of a /g pattern", () => {
    const pattern = /^count (\d+)$/g;
    expect(matchedValues(pattern, "count 3")).toEqual([3]);
    expect(matchedValues(pattern, "count 3")).toEqual([3]);
  });

  it("still coerces a typed {int} capture to a number", () => {
    const step = defineStep({
      pattern: "I have {count:int} cukes",
      description: "typed int capture",
      args: z.object({ count: z.number() }),
      returns: z.object({}),
      run() {
        return {};
      },
    });
    const vocabulary: Vocabulary = new Map([
      ["have-cukes", { kind: "typed", name: "have-cukes", filePath: "features/steps/have-cukes.ts", step }],
    ]);
    const outcome = matchPickleStep("I have 5 cukes", buildStepBindings(vocabulary));
    expect(outcome).toMatchObject({ kind: "matched", values: [5] });
  });
});
