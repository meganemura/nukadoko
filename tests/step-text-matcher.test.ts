import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, it } from "vitest";
import { z } from "zod";
import { checkBindings } from "../src/check/binding-check.js";
import { createStepTextMatcher, matchPickleStepText } from "../src/check/feature-check.js";
import type { Vocabulary, VocabularyEntry } from "../src/discover/discover-steps.js";
import { defineStep } from "../src/step/define-step.js";

function vocab(entries: Record<string, Extract<VocabularyEntry, { kind: "typed" }>["step"]>): Vocabulary {
  const map = new Map<string, VocabularyEntry>();
  for (const [name, step] of Object.entries(entries)) {
    map.set(name, { kind: "typed", name, filePath: `features/steps/${name}.ts`, step });
  }
  return map;
}

const patterns = checkBindings(
  vocab({
    ready: defineStep({
      pattern: "the workspace is ready",
      description: "d",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    }),
    project: defineStep({
      pattern: "project {name:string} exists",
      description: "d",
      args: z.object({ name: z.string() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    }),
    "shared-string": defineStep({
      pattern: "shared {value:string}",
      description: "d",
      args: z.object({ value: z.string() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    }),
    "shared-word": defineStep({
      pattern: "shared {value:word}",
      description: "d",
      args: z.object({ value: z.string() }),
      returns: z.object({}),
      async run() {
        return {};
      },
    }),
  }),
).patterns;

const matchingTexts = ["the workspace is ready", 'project "alpha" exists', 'shared "value"'] as const;
const unmatchingTexts = ["the workspace is absent", "project alpha exists", "unknown step"] as const;
const textGenerator = gs.sampledFrom([...matchingTexts, ...unmatchingTexts]);

it("returns the uncached match result for every generated sequence", () =>
  hegel.test((tc) => {
    const repeated = tc.draw(textGenerator);
    const texts = [
      tc.draw(gs.sampledFrom(matchingTexts)),
      tc.draw(gs.sampledFrom(unmatchingTexts)),
      repeated,
      ...tc.draw(gs.arrays(textGenerator)),
      repeated,
    ];
    const match = createStepTextMatcher(patterns);

    for (const text of texts) {
      expect(match(text)).toEqual(matchPickleStepText(text, patterns));
    }
  }));
