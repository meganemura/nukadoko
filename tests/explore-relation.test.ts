import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineRelation, defineStep, relationEntry } from "../src/index.js";
import { exploreRelation, type OpenSequence } from "../src/explore/index.js";
import type { Step } from "../src/step/define-step.js";

// Responsibility: `exploreRelation` runs the source and the follow in two
// worlds, judges them with `relate`, and returns both sequences when it
// fails. The system is an in-memory counter that forgets on every open.

const addCount = defineStep({
  pattern: "{n:int} is added",
  description: "add to the counter",
  args: z.object({ n: z.number().int() }),
  returns: z.object({ total: z.number().int() }),
  async run() {
    return { total: 0 };
  },
});

const names = new Map<Step, string>([[addCount, "add-count"]]);
const resolve = (step: Step) => {
  const name = names.get(step);
  return name === undefined ? { error: "this step is not in the vocabulary" } : { name };
};

const counter: OpenSequence = async () => {
  let total = 0;
  return {
    async run(_name, args) {
      total += (args as { n: number }).n;
      return { ok: true, result: { total } };
    },
    async close() {},
  };
};

describe("exploreRelation", () => {
  it("holds when adding in either order reaches the same total", async () => {
    const relation = defineRelation({
      name: "addition commutes",
      source: [relationEntry(addCount, { n: 2 }), relationEntry(addCount, { n: 5 })],
      follow: (source) => [...source].reverse(),
      relate: (source, follow) => source[1].total === follow[1]!.total,
    });
    expect(await exploreRelation({ relation, resolve, open: counter })).toEqual({
      status: "passed",
      source: [
        { name: "add-count", args: { n: 2 } },
        { name: "add-count", args: { n: 5 } },
      ],
      follow: [
        { name: "add-count", args: { n: 5 } },
        { name: "add-count", args: { n: 2 } },
      ],
    });
  });

  it("fails with both sequences when relate does not hold", async () => {
    const relation = defineRelation({
      name: "doubling doubles",
      source: [relationEntry(addCount, { n: 3 })],
      follow: () => [relationEntry(addCount, { n: 3 }), relationEntry(addCount, { n: 4 })],
      relate: (source, follow) => follow[1].total === source[0].total * 2,
    });
    expect(await exploreRelation({ relation, resolve, open: counter })).toEqual({
      status: "failed",
      source: [{ name: "add-count", args: { n: 3 } }],
      follow: [
        { name: "add-count", args: { n: 3 } },
        { name: "add-count", args: { n: 4 } },
      ],
      failure: {
        sequence: "relate",
        message: 'relate returned false for source results [{"total":3}] and follow results [{"total":3},{"total":7}]',
      },
      sourceOutcomes: [{ ok: true, result: { total: 3 } }],
      followOutcomes: [
        { ok: true, result: { total: 3 } },
        { ok: true, result: { total: 7 } },
      ],
    });
  });

  it("stops before running when follow names a step outside the vocabulary", async () => {
    const stray = defineStep({
      description: "not registered",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    let opened = 0;
    const relation = defineRelation({
      name: "stray",
      source: [relationEntry(addCount, { n: 1 })],
      follow: () => [relationEntry(stray, {})],
      relate: () => true,
    });
    const result = await exploreRelation({
      relation,
      resolve,
      open: async () => {
        opened += 1;
        return counter();
      },
    });
    expect(result).toEqual({ status: "relation-error", message: "follow step 1: this step is not in the vocabulary" });
    expect(opened).toBe(0);
  });
});
