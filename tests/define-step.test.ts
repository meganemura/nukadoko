import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStep, isStep } from "../src/step/define-step.js";

// Node's setTimeout keeps a delay only inside 1..2^31-1. Above that, and for
// a non-finite or non-positive delay, it waits 1ms, so the step is recorded
// as timed out for a deadline that never ran. 2^31-1 is the last value that
// still means what the author wrote.
const MAX_STEP_TIMEOUT_MS = 2_147_483_647;

function validDefinition() {
  return {
    description: "d",
    args: z.object({}),
    returns: z.object({}),
    async run() {
      return {};
    },
  };
}

function refusal(definition: object): Error {
  try {
    defineStep(definition as never);
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("defineStep accepted a malformed definition");
}

function deadlineSetTimeoutHonors(timeout: number): boolean {
  return Number.isFinite(timeout) && timeout > 0 && timeout <= MAX_STEP_TIMEOUT_MS;
}

describe("defineStep", () => {
  it("brands its return value so discovery can recognize it", () => {
    const step = defineStep({
      pattern: "a thing happens",
      description: "does a thing",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    expect(isStep(step)).toBe(true);
  });

  it("defaults mutates to true", () => {
    const step = defineStep({
      description: "no explicit mutates",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    expect(step.mutates).toBe(true);
  });

  it("honors an explicit mutates: false", () => {
    const step = defineStep({
      description: "read-only",
      args: z.object({}),
      returns: z.object({}),
      mutates: false,
      async run() {
        return {};
      },
    });
    expect(step.mutates).toBe(false);
  });

  it("wraps a single pattern into patterns", () => {
    const step = defineStep({
      pattern: "one pattern",
      description: "d",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    expect(step.patterns).toEqual(["one pattern"]);
  });

  it("combines pattern and patterns, pattern first", () => {
    const step = defineStep({
      pattern: "primary",
      patterns: ["alias one", "alias two"],
      description: "d",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    expect(step.patterns).toEqual(["primary", "alias one", "alias two"]);
  });

  it("allows omitting patterns entirely for CLI-only vocabulary", () => {
    const step = defineStep({
      description: "cli only",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    expect(step.patterns).toEqual([]);
  });

  it("carries an explicit rationale onto Step.rationale", () => {
    const step = defineStep({
      description: "does a thing",
      rationale: "chose X over Y because Y rejects malformed input",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    expect(step.rationale).toBe("chose X over Y because Y rejects malformed input");
  });

  it("leaves rationale undefined when omitted (no default)", () => {
    const step = defineStep({
      description: "no explicit rationale",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    expect(step.rationale).toBeUndefined();
  });

  it("does not consider an arbitrary object a step", () => {
    expect(isStep({ pattern: "not a step" })).toBe(false);
    expect(isStep(undefined)).toBe(false);
    expect(isStep(null)).toBe(false);
    expect(isStep(() => undefined)).toBe(false);
  });

  it("still runs a valid step, including a deadline at the timer's own limit", () => {
    let ran = false;
    const step = defineStep({
      ...validDefinition(),
      timeout: MAX_STEP_TIMEOUT_MS,
      run() {
        ran = true;
        return {};
      },
    });
    expect(step.timeout).toBe(MAX_STEP_TIMEOUT_MS);
    expect(step.run({} as never, {})).toEqual({});
    expect(ran).toBe(true);
    expect(defineStep(validDefinition()).timeout).toBeUndefined();

    const part = defineStep({
      description: "part",
      args: z.string(),
      returns: z.number(),
      run(_fixtures, text: string) {
        return text.length;
      },
    });
    const composite = defineStep({ ...validDefinition(), parts: [part] });
    expect(composite.parts).toEqual([part]);
    expect(part.run({} as never, "ab")).toBe(2);
  });

  it("refuses args that are not a zod schema", () => {
    for (const args of [undefined, null, {}, "name"]) {
      const error = refusal({ ...validDefinition(), args });
      expect(error.name).toBe("InvalidStepDefinitionError");
      expect(error.name).not.toBe("TypeError");
      expect(error.message).toContain("args must be a zod schema");
    }
  });

  it("refuses returns that are not a zod schema", () => {
    const error = refusal({ ...validDefinition(), returns: { id: "string" } });
    expect(error.name).toBe("InvalidStepDefinitionError");
    expect(error.message).toContain("returns must be a zod schema");
  });

  it("refuses an object that only has a safeParse method, as args and as returns", () => {
    const lookalike = {
      safeParse() {
        return { success: true, data: {} };
      },
    };
    const forArgs = refusal({ ...validDefinition(), args: lookalike });
    expect(forArgs.name).toBe("InvalidStepDefinitionError");
    expect(forArgs.message).toContain("args must be a zod schema");
    const forReturns = refusal({ ...validDefinition(), returns: lookalike });
    expect(forReturns.name).toBe("InvalidStepDefinitionError");
    expect(forReturns.message).toContain("returns must be a zod schema");
  });

  it("refuses a run that is not a function", () => {
    const error = refusal({ ...validDefinition(), run: undefined });
    expect(error.name).toBe("InvalidStepDefinitionError");
    expect(error.message).toContain("run must be a function");
  });

  it("refuses a pattern that is not a string", () => {
    const error = refusal({ ...validDefinition(), pattern: ["a thing happens", "alias"] });
    expect(error.name).toBe("InvalidStepDefinitionError");
    expect(error.message).toContain("pattern must be a string");
  });

  it("refuses patterns that are not an array of strings", () => {
    const error = refusal({ ...validDefinition(), patterns: ["ok", 1] });
    expect(error.name).toBe("InvalidStepDefinitionError");
    expect(error.message).toContain("patterns must be an array of strings");
  });

  it("refuses a parts entry that is not a step", () => {
    const part = defineStep(validDefinition());
    const error = refusal({ ...validDefinition(), parts: [part, undefined] });
    expect(error.name).toBe("InvalidStepDefinitionError");
    expect(error.message).toContain("parts must be an array of steps");
  });

  it("refuses a timeout setTimeout would not honor, and says so as a timeout", () => {
    for (const timeout of [Number.POSITIVE_INFINITY, 0, -5, Number.NaN, 2 ** 31]) {
      const error = refusal({ ...validDefinition(), timeout });
      expect(error.name).toBe("InvalidStepDefinitionError");
      expect(error.message).toContain(
        "timeout must be a finite number of milliseconds greater than 0 and at most 2147483647",
      );
      expect(error.message).not.toContain("timed out after");
    }
  });

  it("accepts a per-step timeout exactly when setTimeout would honor it", () =>
    hegel.test((tc) => {
      const timeout = tc.draw(gs.floats({ allowNan: true, allowInfinity: true }));
      const definition = { ...validDefinition(), timeout };
      if (deadlineSetTimeoutHonors(timeout)) {
        expect(defineStep(definition).timeout).toBe(timeout);
      } else {
        const error = refusal(definition);
        expect(error.name).toBe("InvalidStepDefinitionError");
        expect(error.message).toContain("timeout must be a finite number");
        expect(error.message).not.toContain("timed out after");
      }
    }));

  it("gives a step without returns an empty-object schema that reads a run returning nothing as {}", async () => {
    const step = defineStep({
      description: "asserts only",
      args: z.object({ sum: z.number() }),
      mutates: false,
      run({}, { sum }) {
        if (sum !== 4) throw new Error(`expected 4, got ${sum}`);
      },
    });
    const returned = await step.run({} as never, { sum: 4 });
    expect(returned).toBeUndefined();
    expect(step.returns.safeParse(returned)).toEqual({ success: true, data: {} });
    expect(step.returns.safeParse({ extra: 1 })).toEqual({ success: true, data: {} });
    expect(step.returns.safeParse("text").success).toBe(false);
  });

  it("keeps an explicit returns schema's own demand at the type level", () => {
    const withId = defineStep({
      description: "produces an id",
      args: z.object({}),
      returns: z.object({ id: z.string() }),
      run() {
        return { id: "p-1" };
      },
    });
    const assertOnly = defineStep({
      description: "returns nothing",
      args: z.object({}),
      run() {},
    });
    defineStep({
      description: "explicit returns",
      args: z.object({}),
      returns: z.object({ id: z.string() }),
      // @ts-expect-error a declared returns schema still needs its value
      run() {},
    });
    defineStep({
      description: "reads an id",
      args: z.object({ id: z.string() }),
      from: { id: [withId, "id"] },
      run() {},
    });
    defineStep({
      description: "reads a key a step without returns does not have",
      args: z.object({ id: z.string() }),
      // @ts-expect-error a step without returns has no key to cite
      from: { id: [assertOnly, "id"] },
      run() {},
    });
    expect(assertOnly.returns.safeParse(undefined)).toEqual({ success: true, data: {} });
  });
});
