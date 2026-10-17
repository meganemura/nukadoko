import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { experimental_defineModel, defineStep, experimental_modelCommand } from "../src/index.js";
import { exploreModel, type OpenSequence, type PlannedStep } from "../src/explore/index.js";

// Responsibility: `exploreModel` finds a failing sequence from a seed,
// shrinks it to the shortest one, and reports the same thing for the same
// seed. The system under test is an in-memory list with a planted bug:
// adding a number twice stores it twice, while the model keeps a set.

const addNumber = defineStep({
  pattern: "the number {n:int} is added",
  description: "add a number",
  args: z.object({ n: z.number().int() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});

const countNumbers = defineStep({
  pattern: "the count is read",
  description: "read the count",
  args: z.object({}),
  returns: z.object({ count: z.number().int() }),
  mutates: false,
  async run() {
    return { count: 0 };
  },
});

const setModel = experimental_defineModel(() => new Set<number>()).commands({
  "add-number": experimental_modelCommand(addNumber)({
    args: (_state, draw) => ({ n: draw.pick([1, 2, 3, 4, 5]) }),
    pre: () => true,
    next: (state, args) => new Set([...state, args.n]),
    post: () => true,
  }),
  "count-numbers": experimental_modelCommand(countNumbers)({
    args: () => ({}),
    pre: () => true,
    next: (state) => state,
    post: (state, _args, result) => result.count === state.size,
  }),
});

function listSystem(): { open: OpenSequence; opened: () => number } {
  let opened = 0;
  return {
    opened: () => opened,
    open: async () => {
      opened += 1;
      const stored: number[] = [];
      return {
        async run(name, args) {
          if (name === "add-number") {
            stored.push((args as { n: number }).n);
            return { ok: true, result: {} };
          }
          return { ok: true, result: { count: stored.length } };
        },
        async close() {},
      };
    },
  };
}

function replayFails(steps: readonly PlannedStep[]): boolean {
  const stored: number[] = [];
  const seen = new Set<number>();
  for (const step of steps) {
    if (step.name === "add-number") {
      const n = (step.args as { n: number }).n;
      stored.push(n);
      seen.add(n);
    } else if (stored.length !== seen.size) {
      return true;
    }
  }
  return false;
}

describe("exploreModel", () => {
  it("shrinks the planted bug to two equal adds and one count", async () => {
    const system = listSystem();
    const result = await exploreModel({ model: setModel, seed: 7, runs: 50, length: 10, open: system.open });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.shrunk).toEqual([
      { name: "add-number", args: { n: 1 } },
      { name: "add-number", args: { n: 1 } },
      { name: "count-numbers", args: {} },
    ]);
    expect(result.failure).toEqual({
      index: 2,
      kind: "post-false",
      command: "count-numbers",
      message: 'post of command "count-numbers" returned false for result {"count":2}',
    });
    expect(result.found.length).toBeGreaterThanOrEqual(3);
  });

  it("stops shrinking after maxShrinkAttempts sequences", async () => {
    const unlimited = await exploreModel({ model: setModel, seed: 7, runs: 50, length: 10, open: listSystem().open });
    expect(unlimited.status === "failed" && unlimited.shrinkAttempts > 3).toBe(true);

    const system = listSystem();
    const result = await exploreModel({
      model: setModel,
      seed: 7,
      runs: 50,
      length: 10,
      open: system.open,
      maxShrinkAttempts: 3,
    });
    expect(result.status === "failed" ? result.shrinkAttempts : undefined).toBe(3);
    const runsBeforeFailure = result.status === "failed" ? result.run : 0;
    expect(system.opened()).toBe(runsBeforeFailure + 3);
  });

  it("passes when the system keeps a set, and counts every step it ran", async () => {
    const result = await exploreModel({
      model: setModel,
      seed: 7,
      runs: 4,
      length: 5,
      open: async () => {
        const stored = new Set<number>();
        return {
          async run(name, args) {
            if (name === "add-number") stored.add((args as { n: number }).n);
            return { ok: true, result: name === "add-number" ? {} : { count: stored.size } };
          },
          async close() {},
        };
      },
    });
    expect(result).toEqual({ status: "passed", seed: 7, runs: 4, steps: 20 });
  });

  it("reports a step that fails as the failure, with the step's own message", async () => {
    const result = await exploreModel({
      model: setModel,
      seed: 1,
      runs: 1,
      length: 5,
      open: async () => ({
        async run() {
          return { ok: false, message: "connection refused" };
        },
        async close() {},
      }),
    });
    expect(result).toMatchObject({
      status: "failed",
      run: 1,
      shrunk: [{ name: "count-numbers", args: {} }],
      failure: { index: 0, message: "connection refused" },
    });
  });

  it("shrinks a drawn value to the first item and no further", async () => {
    const addOnly = experimental_defineModel(() => 0).commands({
      "add-number": experimental_modelCommand(addNumber)({
        args: (_state, draw) => ({ n: draw.pick([3, 4, 5]) }),
        pre: () => true,
        next: (state) => state + 1,
        post: () => true,
      }),
    });
    const result = await exploreModel({
      model: addOnly,
      seed: 11,
      runs: 1,
      length: 4,
      open: async () => ({
        async run(_name, args) {
          return { ok: false, message: `refused ${JSON.stringify(args)}` };
        },
        async close() {},
      }),
    });
    expect(result).toMatchObject({
      status: "failed",
      shrunk: [{ name: "add-number", args: { n: 3 } }],
      failure: { index: 0, message: 'refused {"n":3}' },
    });
  });

  it("keeps the failure it found when a shorter sequence fails another way", async () => {
    const result = await exploreModel({
      model: setModel,
      seed: 2,
      runs: 20,
      length: 10,
      open: async () => {
        const stored: number[] = [];
        return {
          async run(name, args) {
            if (name === "count-numbers") return { ok: true, result: { count: stored.length } };
            const { n } = args as { n: number };
            if (n === 1) return { ok: false, message: "1 is refused" };
            stored.push(n);
            return { ok: true, result: {} };
          },
          async close() {},
        };
      },
    });
    expect(result).toMatchObject({
      status: "failed",
      found: [
        { name: "count-numbers", args: {} },
        { name: "add-number", args: { n: 3 } },
        { name: "add-number", args: { n: 3 } },
        { name: "count-numbers", args: {} },
      ],
      shrunk: [
        { name: "add-number", args: { n: 3 } },
        { name: "add-number", args: { n: 3 } },
        { name: "count-numbers", args: {} },
      ],
      failure: {
        index: 2,
        kind: "post-false",
        command: "count-numbers",
        message: 'post of command "count-numbers" returned false for result {"count":2}',
      },
    });
  });

  it("names the model callback that threw instead of running anything", async () => {
    const broken = experimental_defineModel(() => 0).commands({
      "count-numbers": experimental_modelCommand(countNumbers)({
        args: () => {
          throw new Error("no args today");
        },
        pre: () => true,
        next: (state) => state,
        post: () => true,
      }),
    });
    const system = listSystem();
    const result = await exploreModel({ model: broken, seed: 3, runs: 2, length: 3, open: system.open });
    expect(result).toEqual({
      status: "model-error",
      seed: 3,
      run: 1,
      message: 'args of command "count-numbers" threw: no args today',
    });
    expect(system.opened()).toBe(0);
  });

  it("gives the same result for the same seed, and a shrunk sequence that still fails", () =>
    hegel.testAsync(async (tc) => {
      const seed = tc.draw(gs.integers({ minValue: 0, maxValue: 2 ** 32 - 1 }));
      const length = tc.draw(gs.integers({ minValue: 1, maxValue: 8 }));
      const first = await exploreModel({ model: setModel, seed, runs: 3, length, open: listSystem().open });
      const second = await exploreModel({ model: setModel, seed, runs: 3, length, open: listSystem().open });
      expect(second).toEqual(first);
      if (first.status === "failed") {
        expect(replayFails(first.shrunk)).toBe(true);
        expect(first.shrunk.length).toBeLessThanOrEqual(first.found.length);
        expect(first.failure.index).toBe(first.shrunk.length - 1);
        for (const step of first.shrunk) {
          if (step.name === "add-number") expect([1, 2, 3, 4, 5]).toContain((step.args as { n: number }).n);
        }
      }
    }));
});

// Two planted bugs that fail different posts: the third add stores
// nothing, and a count read before any add reports one. A run that first
// fails on the third add can shrink to a sequence that starts with the
// count, which fails too, but on the other command.
const twoBugModel = experimental_defineModel(() => ({ adds: 0 })).commands({
  "add-number": experimental_modelCommand(addNumber)({
    args: (_state, draw) => ({ n: draw.pick([1, 2]) }),
    pre: () => true,
    next: (state) => ({ adds: state.adds + 1 }),
    post: (_state, _args, result) => Object.keys(result).length === 0,
  }),
  "count-numbers": experimental_modelCommand(countNumbers)({
    args: () => ({}),
    pre: () => true,
    next: (state) => state,
    post: (state, _args, result) => result.count === Math.min(state.adds, 2),
  }),
});

function twoBugSystem(): OpenSequence {
  return async () => {
    let adds = 0;
    return {
      async run(name) {
        if (name === "add-number") {
          adds += 1;
          return { ok: true, result: adds === 3 ? { lost: true } : {} };
        }
        return { ok: true, result: { count: adds === 0 ? 1 : Math.min(adds, 2) } };
      },
      async close() {},
    };
  };
}

describe("exploreModel with two failures on different commands", () => {
  it("keeps the shrunk failure on the command the found sequence failed on", async () => {
    const result = await exploreModel({ model: twoBugModel, seed: 4, runs: 20, length: 8, open: twoBugSystem() });
    expect(result).toMatchObject({
      status: "failed",
      found: [
        { name: "add-number", args: { n: 1 } },
        { name: "count-numbers", args: {} },
        { name: "add-number", args: { n: 2 } },
        { name: "count-numbers", args: {} },
        { name: "add-number", args: { n: 1 } },
      ],
      shrunk: [
        { name: "add-number", args: { n: 1 } },
        { name: "add-number", args: { n: 1 } },
        { name: "add-number", args: { n: 1 } },
      ],
      failure: { index: 2, kind: "post-false", command: "add-number" },
    });
  });

  it("names the found sequence's last command as the shrunk failure's command, for any seed", () =>
    hegel.testAsync(async (tc) => {
      const seed = tc.draw(gs.integers({ minValue: 0, maxValue: 2 ** 32 - 1 }));
      const result = await exploreModel({ model: twoBugModel, seed, runs: 20, length: 8, open: twoBugSystem() });
      if (result.status !== "failed") return;
      expect(result.failure.command).toBe(result.found.at(-1)!.name);
      expect(result.shrunk.at(-1)!.name).toBe(result.found.at(-1)!.name);
    }));
});
