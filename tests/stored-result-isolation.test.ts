import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { z } from "zod";
import type { NukadokoConfig } from "../src/config/schema.js";
import { buildStepFixtures, createStepContext } from "../src/context/create-context.js";
import { defineStep } from "../src/step/define-step.js";

// Responsibility: `ctx.resultOf` and `ctx.call` hand the caller the stored
// result object. An in-place change then rewrites what a later read returns
// and what the step record keeps (`used` for a resultOf read, `calls[].result`
// for a call). docs/spec.md "Context API" says of resultOf that nothing can
// write to it. These tests pin that, and the same isolation for call, without
// a feature file: the chain lives in the executor, and `createStepContext`
// only wraps the reader it is given.

const listSchema = z.object({ items: z.array(z.number()) });
const nestedSchema = z.object({ item: z.object({ n: z.number() }) });
const emptySchema = z.object({});

const integerLists = gs.arrays(gs.integers({ minValue: -20, maxValue: 20 }), {
  minSize: 0,
  maxSize: 8,
});

function baseConfig(): NukadokoConfig {
  return {
    featuresDir: "features",
    additionalFeatureDirs: [],
    stateDir: ".nukadoko",
    envFiles: [],
    parameterTypes: [],
    worldParameters: {},
    fixtures: {},
    fixtureTimeout: 60_000,
    secrets: { public: [], redact: [] },
    retention: { runs: 20, adHocDays: 7 },
    stepTimeout: 1_200_000,
    browserType: "chromium",
  };
}

function produceList() {
  return defineStep({
    description: "produce a list",
    args: emptySchema,
    returns: listSchema,
    async run() {
      return { items: [] };
    },
  });
}

function contextReading(result: unknown) {
  const stored = { result, recordId: "rec-produce", stepName: "produce-list" };
  const handle = createStepContext({
    config: baseConfig(),
    evidenceDir: "/tmp/nukadoko-unused",
    env: {},
    resultOf: () => stored,
  });
  return { ...handle, stored };
}

describe("ctx.resultOf does not hand out the stored result", () => {
  it("an in-place sort does not change the next read or the used result", () => {
    const produce = produceList();
    const { ctx, usedSnapshot, stored } = contextReading({ items: [3, 1, 2] });

    const view = ctx.resultOf(produce);
    if (view === undefined) {
      throw new Error("expected the stored result");
    }
    view.items.sort((a, b) => a - b);

    expect(view.items).toEqual([1, 2, 3]);
    expect(stored.result).toEqual({ items: [3, 1, 2] });
    expect(ctx.resultOf(produce)).toEqual({ items: [3, 1, 2] });
    expect(usedSnapshot()).toEqual([
      { step_record_id: "rec-produce", step: "produce-list", result: { items: [3, 1, 2] } },
    ]);
  });

  it("an in-place change to a nested field does not change the next read", () => {
    const produce = defineStep({
      description: "produce a nested value",
      args: emptySchema,
      returns: nestedSchema,
      async run() {
        return { item: { n: 0 } };
      },
    });
    const { ctx, stored } = contextReading({ item: { n: 1 } });

    const view = ctx.resultOf(produce);
    if (view === undefined) {
      throw new Error("expected the stored result");
    }
    view.item.n = 2;

    expect(view.item.n).toBe(2);
    expect(stored.result).toEqual({ item: { n: 1 } });
    expect(ctx.resultOf(produce)).toEqual({ item: { n: 1 } });
  });

  it("still returns undefined and null, which have nothing to alias", () => {
    const produce = defineStep({
      description: "produce anything",
      args: emptySchema,
      returns: z.unknown(),
      async run() {
        return undefined;
      },
    });

    const missing = contextReading(undefined);
    expect(missing.ctx.resultOf(produce)).toBeUndefined();
    expect(missing.usedSnapshot()[0]?.result).toBeUndefined();

    const empty = contextReading(null);
    expect(empty.ctx.resultOf(produce)).toBeNull();
    expect(empty.stored.result).toBeNull();
  });

  it("keeps every drawn list intact after the caller appends to its copy", () =>
    hegel.test((tc) => {
      const items = tc.draw(integerLists);
      const expected = [...items];
      const produce = produceList();
      const { ctx, stored } = contextReading({ items: [...items] });
      const view = ctx.resultOf(produce);
      if (view === undefined) {
        throw new Error("expected the stored result");
      }
      view.items.push(999);
      expect(view.items).toEqual([...expected, 999]);
      expect(stored.result).toEqual({ items: expected });
      expect(ctx.resultOf(produce)).toEqual({ items: expected });
    }));
});

describe("ctx.call does not hand out the recorded result", () => {
  async function callList(items: readonly number[]) {
    const part = defineStep({
      description: "produce a list",
      args: emptySchema,
      returns: listSchema,
      async run() {
        return { items: [...items] };
      },
    });
    const composite = defineStep({
      description: "call the part",
      args: emptySchema,
      returns: emptySchema,
      parts: [part],
      async run() {
        return {};
      },
    });
    const handle = createStepContext({
      config: baseConfig(),
      evidenceDir: "/tmp/nukadoko-unused",
      env: {},
      stepNameOf: (step) => (step === part ? "produce-list" : undefined),
    });
    const fixtures = await buildStepFixtures(handle.ctx, []);
    handle.beginStepRun(composite, fixtures);
    const view = await handle.ctx.call(part, {});
    return { view, calls: handle.callsSnapshot };
  }

  it("an in-place sort does not change calls[].result", async () => {
    const { view, calls } = await callList([3, 1, 2]);
    view.items.sort((a, b) => a - b);

    expect(view.items).toEqual([1, 2, 3]);
    expect(calls()).toEqual([
      expect.objectContaining({
        step: "produce-list",
        result: { items: [3, 1, 2] },
      }),
    ]);
  });

  it("keeps every drawn list intact in the call record after the caller appends", () =>
    hegel.testAsync(async (tc) => {
      const items = tc.draw(integerLists);
      const { view, calls } = await callList(items);
      view.items.push(999);
      expect(calls()[0]?.result).toEqual({ items: [...items] });
    }));
});
