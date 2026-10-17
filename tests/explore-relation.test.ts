import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { experimental_defineModel, experimental_defineRelation, defineStep, experimental_modelCommand, experimental_relationEntry } from "../src/index.js";
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
    const relation = experimental_defineRelation({
      name: "addition commutes",
      source: [experimental_relationEntry(addCount, { n: 2 }), experimental_relationEntry(addCount, { n: 5 })],
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
    const relation = experimental_defineRelation({
      name: "doubling doubles",
      source: [experimental_relationEntry(addCount, { n: 3 })],
      follow: () => [experimental_relationEntry(addCount, { n: 3 }), experimental_relationEntry(addCount, { n: 4 })],
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
        threw: false,
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
    const relation = experimental_defineRelation({
      name: "stray",
      source: [experimental_relationEntry(addCount, { n: 1 })],
      follow: () => [experimental_relationEntry(stray, {})],
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

  describe("with a generated source", () => {
    // The counter loses the second add of every world, so adding the same
    // numbers in reverse order can end on a different total.
    const dropsSecondAdd: OpenSequence = async () => {
      let total = 0;
      let adds = 0;
      return {
        async run(_name, args) {
          adds += 1;
          if (adds !== 2) total += (args as { n: number }).n;
          return { ok: true, result: { total } };
        },
        async close() {},
      };
    };

    const reversed = experimental_defineRelation({
      name: "adding in reverse order reaches the same total",
      source: (draw, length) =>
        Array.from({ length: draw.int(1, length) }, () => experimental_relationEntry(addCount, { n: draw.int(0, 9) })),
      follow: (source) => [...source].reverse(),
      relate: (source, follow) => source.at(-1)!.total === follow.at(-1)!.total,
    });

    it("finds the dropped second add and shrinks the source to two adds", async () => {
      const result = await exploreRelation({ relation: reversed, resolve, open: dropsSecondAdd, seed: 1, runs: 20, length: 6 });
      expect(result).toMatchObject({
        status: "failed",
        source: [
          { name: "add-count", args: { n: 1 } },
          { name: "add-count", args: { n: 0 } },
        ],
        follow: [
          { name: "add-count", args: { n: 0 } },
          { name: "add-count", args: { n: 1 } },
        ],
        failure: {
          sequence: "relate",
          threw: false,
          message: 'relate returned false for source results [{"total":1},{"total":1}] and follow results [{"total":0},{"total":0}]',
        },
        generated: { seed: 1, run: 1 },
      });
    });

    it("draws its source from a model's commands", async () => {
      const adds = experimental_defineModel(() => 0).commands({
        "add-count": experimental_modelCommand(addCount)({
          args: (_state, draw) => ({ n: draw.int(0, 9) }),
          pre: () => true,
          next: (state) => state + 1,
          post: () => true,
        }),
      });
      const relation = experimental_defineRelation({
        name: "adding in reverse order reaches the same total",
        source: adds,
        follow: (source) => [...source].reverse(),
        relate: (source, follow) =>
          (source.at(-1) as { total: number }).total === (follow.at(-1) as { total: number }).total,
      });
      const result = await exploreRelation({ relation, resolve, open: dropsSecondAdd, seed: 1, runs: 20, length: 6 });
      expect(result).toMatchObject({
        status: "failed",
        source: [
          { name: "add-count", args: { n: 0 } },
          { name: "add-count", args: { n: 1 } },
        ],
        follow: [
          { name: "add-count", args: { n: 1 } },
          { name: "add-count", args: { n: 0 } },
        ],
        failure: { sequence: "relate" },
      });
    });

    it("passes when the counter keeps every add, and counts the runs", async () => {
      const result = await exploreRelation({ relation: reversed, resolve, open: counter, seed: 1, runs: 7, length: 4 });
      expect(result).toEqual({ status: "passed", generated: { seed: 1, runs: 7 } });
    });

    it("gives the same result for the same seed", () =>
      hegel.testAsync(async (tc) => {
        const seed = tc.draw(gs.integers({ minValue: 0, maxValue: 2 ** 32 - 1 }));
        const length = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
        const options = { relation: reversed, resolve, seed, runs: 3, length };
        const first = await exploreRelation({ ...options, open: dropsSecondAdd });
        expect(await exploreRelation({ ...options, open: dropsSecondAdd })).toEqual(first);
        if (first.status === "failed") expect(first.source.length).toBeLessThanOrEqual(length);
      }));
  });
});
