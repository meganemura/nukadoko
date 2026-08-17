import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStep } from "../src/step/define-step.js";
import { stepFixtureNames } from "../src/step/step-fixture-names.js";

// Responsibility: unit tests for src/step/step-fixture-names.ts's
// `stepFixtureNames` — the transitive closure over a step's own
// destructured names and every part it declares (docs/spec.md "Parts").
// Exercised directly (no CLI, no discovery) so the union and the cycle
// guard are each pinned down in isolation.

const emptySchema = z.object({});

describe("stepFixtureNames", () => {
  it("returns just a step's own destructured names when it declares no parts", () => {
    const step = defineStep({
      description: "no parts",
      args: emptySchema,
      returns: emptySchema,
      async run({ section }) {
        void section;
        return {};
      },
    });
    expect([...stepFixtureNames(step)].sort()).toEqual(["section"]);
  });

  it("unions a part's own names into the caller's", () => {
    const part = defineStep({
      description: "a part that needs page",
      args: emptySchema,
      returns: emptySchema,
      async run({ page }) {
        void page;
        return {};
      },
    });
    const composite = defineStep({
      description: "calls the part",
      args: emptySchema,
      returns: emptySchema,
      parts: [part],
      async run({ call }) {
        await call(part, {});
        return {};
      },
    });
    expect([...stepFixtureNames(composite)].sort()).toEqual(["call", "page"]);
  });

  it("closes transitively over a chain of parts (part calling part)", () => {
    const grandchild = defineStep({
      description: "grandchild",
      args: emptySchema,
      returns: emptySchema,
      async run({ request }) {
        void request;
        return {};
      },
    });
    const child = defineStep({
      description: "child",
      args: emptySchema,
      returns: emptySchema,
      parts: [grandchild],
      async run({ call }) {
        await call(grandchild, {});
        return {};
      },
    });
    const root = defineStep({
      description: "root",
      args: emptySchema,
      returns: emptySchema,
      parts: [child],
      async run({ call }) {
        await call(child, {});
        return {};
      },
    });
    expect([...stepFixtureNames(root)].sort()).toEqual(["call", "request"]);
  });

  it("does not loop forever over a cycle in parts", () => {
    const stepA = defineStep({
      description: "a",
      args: emptySchema,
      returns: emptySchema,
      async run({ env }) {
        void env;
        return {};
      },
    });
    const stepB = defineStep({
      description: "b",
      args: emptySchema,
      returns: emptySchema,
      parts: [stepA],
      async run({ requireEnv }) {
        void requireEnv;
        return {};
      },
    });
    // A real cycle a step author could actually reach (two step files
    // importing each other's default export circularly) — built here by
    // mutating the array `defineStep` already produced for `stepA`, since
    // `stepB` did not exist yet at the point `stepA` was defined.
    (stepA.parts as unknown as unknown[]).push(stepB);

    expect(() => stepFixtureNames(stepA)).not.toThrow();
    expect([...stepFixtureNames(stepA)].sort()).toEqual(["env", "requireEnv"]);
  });
});
