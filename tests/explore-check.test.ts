import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { checkExploreDeclarations } from "../src/check/explore-check.js";
import type { VocabularyEntry } from "../src/discover/discover-steps.js";
import { MODEL_BRAND, type Model } from "../src/step/define-explore.js";
import { defineModel, defineStep, modelCommand, z } from "../src/index.js";

// Responsibility: `checkExploreDeclarations` is a pure reading of a
// declaration. The findings for a set of command names do not depend on
// the order those commands are written in, and the reading does not call
// the functions the declaration stores.

type ClassName = "unknown" | "request" | "browser";

const classList = gs.arrays(gs.sampledFrom(["unknown", "request", "browser"] satisfies ClassName[]), {
  minSize: 0,
  maxSize: 5,
});

function stepNamed(name: string) {
  return defineStep({
    description: name,
    args: z.object({}),
    returns: z.object({}),
    run() {
      return {};
    },
  });
}

function modelFrom(commands: Record<string, Model["commands"][string]>): Model {
  return { [MODEL_BRAND]: true, initial: () => ({}), commands };
}

function classifiedFindings(classes: readonly ClassName[], reverse: boolean): string[] {
  const pairs = classes.map((kind, index) => ({ kind, name: `step-${index}` }));
  const ordered = reverse ? [...pairs].reverse() : pairs;
  const vocabulary = new Map<string, VocabularyEntry>();
  const browserSteps = new Set<object>();
  const commands: Record<string, Model["commands"][string]> = {};
  for (const pair of ordered) {
    const step = stepNamed(pair.name);
    if (pair.kind !== "unknown") {
      vocabulary.set(pair.name, {
        kind: "typed",
        name: pair.name,
        filePath: `features/steps/${pair.name}.ts`,
        step,
      });
    }
    if (pair.kind === "browser") {
      browserSteps.add(step);
    }
    commands[pair.name] = {
      step,
      args: () => ({}),
      pre: () => true,
      next: (state) => state,
      post: () => true,
    };
  }
  return checkExploreDeclarations({
    vocabulary,
    models: [{ filePath: "model.ts", model: modelFrom(commands) }],
    relations: [],
    needsBrowser: (step) => browserSteps.has(step),
  }).map((issue) => `${issue.code}:${issue.step}`);
}

describe("checkExploreDeclarations", () => {
  it("reports the same findings for every command order", () =>
    hegel.test((tc) => {
      const classes = tc.draw(classList);
      const forward = classifiedFindings(classes, false);
      const reversed = classifiedFindings(classes, true);
      expect([...forward].sort()).toEqual([...reversed].sort());
      for (const [index, kind] of classes.entries()) {
        const name = `step-${index}`;
        const hit = forward.find((line) => line.endsWith(`:${name}`));
        if (kind === "request") {
          expect(hit).toBeUndefined();
        } else if (kind === "browser") {
          expect(hit).toBe(`explore-browser-step:${name}`);
        } else {
          expect(hit).toBe(`explore-unknown-step:${name}`);
        }
      }
    }));

  it("does not call the model", () => {
    const calls: string[] = [];
    const step = stepNamed("request");
  const vocabulary = new Map<string, VocabularyEntry>([
      ["request", { kind: "typed", name: "request", filePath: "features/steps/request.ts", step }],
    ]);
    const model = defineModel(() => {
      calls.push("initial");
      return {};
    }).commands({
      request: modelCommand(step)({
        args: () => {
          calls.push("args");
          return {};
        },
        pre: () => {
          calls.push("pre");
          return true;
        },
        next: (state) => {
          calls.push("next");
          return state;
        },
        post: () => {
          calls.push("post");
          return true;
        },
      }),
    });
    const issues = checkExploreDeclarations({
      vocabulary,
      models: [{ filePath: "model.ts", model }],
      relations: [],
      needsBrowser: () => false,
    });
    expect(issues).toEqual([]);
    expect(calls).toEqual([]);
  });
});
