import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStep, type Step } from "../src/step/define-step.js";
import { formatFixtureIssues, validateStepFixtures } from "../src/step/validate-fixtures.js";

// Responsibility: unit tests for src/step/validate-fixtures.ts's pure
// functions (p4a-fixture-bag task spec, scope item 3) — no discovery, no
// tsx, no filesystem, mirroring tests/validate-from.test.ts's own shape for
// the same reasons that file's header gives: most cases here reach the
// runtime check by bypassing the type system (`as any`/`as unknown as
// Step`), exactly the way a step author's own escape hatch could, since
// that is precisely what this runtime check exists to catch independently
// of the type layer.

function stepWithRun(run: Step["run"]): Step {
  return {
    ...defineStep({
      description: "test step",
      args: z.object({}),
      returns: z.object({}),
      run() {
        return {};
      },
    }),
    run,
  };
}

describe("validateStepFixtures", () => {
  it("returns [] for a step whose run() destructures only known fixtures", () => {
    const step = defineStep({
      description: "clean",
      args: z.object({}),
      returns: z.object({ ok: z.boolean() }),
      async run({ section }) {
        section("done");
        return { ok: true };
      },
    });
    expect(validateStepFixtures("clean-step", step)).toEqual([]);
  });

  it("returns [] for a step whose run() takes no arguments at all", () => {
    const step = defineStep({
      description: "no fixtures",
      args: z.object({}),
      returns: z.object({}),
      run() {
        return {};
      },
    });
    expect(validateStepFixtures("no-fixtures-step", step)).toEqual([]);
  });

  it("flags a destructured name that isn't one of StepFixtures's own members", () => {
    // `as any` on the first parameter is what actually reaches the runtime
    // check here — without it, this line would already fail to compile
    // (this file's own header).
    const step = stepWithRun((async ({ bogus }: any) => {
      void bogus;
      return {};
    }) as Step["run"]);
    const issues = validateStepFixtures("unknown-fixture-step", step);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ step: "unknown-fixture-step" });
    expect(issues[0]?.message).toContain('unknown fixture "bogus"');
  });

  it("flags a default value on a destructured fixture, by its own dedicated message", () => {
    const step = stepWithRun((async ({ baseURL = "unused" }: any) => {
      void baseURL;
      return {};
    }) as Step["run"]);
    const issues = validateStepFixtures("default-value-step", step);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("default value");
  });

  it("flags a rest property in the fixture destructuring", () => {
    const step = stepWithRun((async ({ ...rest }: any) => {
      void rest;
      return {};
    }) as Step["run"]);
    const issues = validateStepFixtures("rest-step", step);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("rest property");
  });

  it("flags a run() whose first argument isn't destructured at all", () => {
    const step = stepWithRun((async (fixtures: any) => {
      void fixtures;
      return {};
    }) as Step["run"]);
    const issues = validateStepFixtures("not-destructured-step", step);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("destructure");
  });
});

describe("formatFixtureIssues", () => {
  it("renders one line per issue, \"<step>: <message>\"", () => {
    const text = formatFixtureIssues([
      { step: "a", message: "first" },
      { step: "b", message: "second" },
    ]);
    expect(text).toBe("a: first\nb: second");
  });
});
