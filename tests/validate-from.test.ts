import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStep, type Step } from "../src/step/define-step.js";
import { registeredStepPredicate, validateStepFrom } from "../src/step/validate-from.js";

// Responsibility: unit tests for src/step/validate-from.ts's pure functions
// (m6a-from-core task spec, item 3) — no discovery, no tsx, no filesystem:
// every `Step` is a plain `defineStep(...)` call in memory. This is the
// runtime backstop the type layer (src/step/define-step.ts's `FromMap`)
// can't fully cover on its own (that file's own header names what it does
// and doesn't check); most cases here are deliberately reached by bypassing
// the type system (`as unknown as Step`) exactly the way a step author's own
// `as` cast could, since that is precisely what this runtime check exists to
// catch.

const upstream = defineStep({
  description: "upstream step",
  args: z.object({}),
  returns: z.object({ id: z.string(), count: z.number() }),
  run() {
    return { id: "u1", count: 1 };
  },
});

function consumer(): Step {
  return defineStep({
    description: "consumer step",
    args: z.object({ upstreamId: z.string() }),
    returns: z.object({ ok: z.boolean() }),
    from: { upstreamId: [upstream, "id"] },
    run() {
      return { ok: true };
    },
  });
}

describe("validateStepFrom", () => {
  it("returns no issues for a well-formed from entry whose upstream is registered", () => {
    const step = consumer();
    const isRegistered = registeredStepPredicate([upstream, step]);
    expect(validateStepFrom("consumer", step, isRegistered)).toEqual([]);
  });

  it("flags an upstream Step that discovery never registered", () => {
    const step = consumer();
    // `upstream` deliberately excluded from the registered set — the same
    // fact a step file reached through a second, separate `await import()`
    // would produce (docs/spec.md "Chaining steps").
    const isRegistered = registeredStepPredicate([step]);
    const issues = validateStepFrom("consumer", step, isRegistered);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ step: "consumer", key: "upstreamId" });
    expect(issues[0]?.message).toContain("never registered");
  });

  it("flags a from value whose upstream isn't a Step at all", () => {
    const step = consumer();
    const broken = {
      ...step,
      from: { upstreamId: [{ not: "a step" }, "id"] },
    } as unknown as Step;
    const issues = validateStepFrom("consumer", broken, () => true);
    expect(issues.some((issue) => issue.message.includes("not a Step"))).toBe(true);
  });

  it("flags an upstream whose returns isn't an object schema", () => {
    const flatUpstream = defineStep({
      description: "upstream with non-object returns",
      args: z.object({}),
      returns: z.string(),
      run() {
        return "plain string";
      },
    });
    const step = {
      ...consumer(),
      from: { upstreamId: [flatUpstream, "id"] },
    } as unknown as Step;
    const isRegistered = registeredStepPredicate([flatUpstream, step]);
    const issues = validateStepFrom("consumer", step, isRegistered);
    expect(issues.some((issue) => issue.message.includes("not an object schema"))).toBe(true);
  });

  it("flags a from key naming something that isn't one of the upstream's returns keys", () => {
    const step = {
      ...consumer(),
      from: { upstreamId: [upstream, "missingKey"] },
    } as unknown as Step;
    const isRegistered = registeredStepPredicate([upstream, step]);
    const issues = validateStepFrom("consumer", step, isRegistered);
    expect(issues.some((issue) => issue.message.includes('"missingKey"'))).toBe(true);
  });

  it("flags a step whose own args isn't an object schema", () => {
    const step = {
      ...consumer(),
      args: z.string(),
    } as unknown as Step;
    const isRegistered = registeredStepPredicate([upstream, step]);
    const issues = validateStepFrom("consumer", step, isRegistered);
    expect(issues.some((issue) => issue.message.includes("this step's args is not an object schema"))).toBe(
      true,
    );
  });

  it("flags a from key that isn't one of this step's own args keys", () => {
    const step = {
      ...consumer(),
      from: { notAnArgsKey: [upstream, "id"] },
    } as unknown as Step;
    const isRegistered = registeredStepPredicate([upstream, step]);
    const issues = validateStepFrom("consumer", step, isRegistered);
    expect(issues.some((issue) => issue.message.includes("not one of this step's own args keys"))).toBe(
      true,
    );
  });

  it("returns [] for a step that declares no from at all", () => {
    const step = defineStep({
      description: "no from here",
      args: z.object({}),
      returns: z.object({ ok: z.boolean() }),
      run() {
        return { ok: true };
      },
    });
    expect(validateStepFrom("no-from", step, () => true)).toEqual([]);
  });
});
