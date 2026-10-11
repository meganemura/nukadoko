import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { z } from "zod";
import { checkBindings } from "../src/check/binding-check.js";
import type { Vocabulary, VocabularyEntry } from "../src/discover/discover-steps.js";
import { bindStepArgs, buildStepBindings, matchPickleStep } from "../src/run/match-step.js";
import { defineStep } from "../src/step/define-step.js";

function vocab(entries: Record<string, Extract<VocabularyEntry, { kind: "typed" }>["step"]>): Vocabulary {
  const map = new Map<string, VocabularyEntry>();
  for (const [name, step] of Object.entries(entries)) {
    map.set(name, { kind: "typed", name, filePath: `features/steps/${name}.ts`, step });
  }
  return map;
}

const rangeStep = defineStep({
  pattern: "a range from {n:int} to {n:int} is set",
  description: "d",
  args: z.object({ n: z.number() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});

describe("a pattern that captures the same key twice", () => {
  it("does not keep only the last value for a range from 1 to 9", () => {
    const vocabulary = vocab({ "set-range": rangeStep });
    const matched = matchPickleStep("a range from 1 to 9 is set", buildStepBindings(vocabulary));
    expect(matched.kind).toBe("matched");
    if (matched.kind !== "matched") return;

    const bound = bindStepArgs(matched.stepName, matched.captures, matched.values, undefined, rangeStep.args);
    expect(bound).not.toEqual({ ok: true, value: { n: 9 } });
    expect(bound.ok).toBe(false);
    if (!bound.ok) {
      expect(bound.message).toContain('"n"');
      expect(bound.partialValue).not.toHaveProperty("n");
    }
  });

  it("reports the repeated key from check, naming that key", () => {
    const result = checkBindings(vocab({ "set-range": rangeStep }));
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "duplicate-capture-key",
        step: "set-range",
        message: expect.stringContaining('"n"'),
      }),
    ]);
  });

  it("names every key captured more than once and keeps neither value", () => {
    const bound = bindStepArgs(
      "span",
      [
        { key: "start", type: "int" },
        { key: "end", type: "int" },
        { key: "start", type: "int" },
        { key: "end", type: "int" },
      ],
      [1, 2, 3, 4],
      undefined,
      z.object({ start: z.number(), end: z.number() }),
    );
    expect(bound.ok).toBe(false);
    if (!bound.ok) {
      expect(bound.message).toContain('"start"');
      expect(bound.message).toContain('"end"');
      expect(bound.partialValue).not.toHaveProperty("start");
      expect(bound.partialValue).not.toHaveProperty("end");
    }
  });

  it("never collapses a repeated key to the later value", () =>
    hegel.test((tc) => {
      const key = tc.draw(gs.fromRegex("[a-z][a-z0-9]{0,7}"));
      const first = tc.draw(gs.integers({ minValue: 0, maxValue: 40 }));
      const second = tc.draw(gs.integers({ minValue: 0, maxValue: 40 }));
      const bound = bindStepArgs(
        "step",
        [
          { key, type: "int" },
          { key, type: "int" },
        ],
        [first, second],
        undefined,
        z.object({ [key]: z.number() }),
      );
      expect(bound.ok).toBe(false);
      if (!bound.ok) {
        expect(bound.message).toContain(`"${key}"`);
        expect(bound.partialValue).not.toHaveProperty(key);
      }
      expect(bound).not.toEqual({ ok: true, value: { [key]: second } });
    }));

  it("keeps both values when the two captures use different keys", () => {
    const bound = bindStepArgs(
      "transfer",
      [
        { key: "from", type: "int" },
        { key: "to", type: "int" },
      ],
      [1, 9],
      undefined,
      z.object({ from: z.number(), to: z.number() }),
    );
    expect(bound).toEqual({ ok: true, value: { from: 1, to: 9 } });
  });
});
