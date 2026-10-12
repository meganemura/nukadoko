import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { z } from "zod";
import { defineStep, type Step } from "../src/step/define-step.js";
import type { FixtureDefinition, FixtureFn } from "../src/step/fixture-types.js";
import { formatFixtureIssues, validateFixtureDefinitions, validateStepFixtures } from "../src/fixture/validate-fixtures.js";

// Responsibility: unit tests for src/fixture/validate-fixtures.ts's pure
// functions — no discovery, no
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

// Builtins a fixture may name. `call` is deliberately absent: a fixture runs
// while its dependencies are built, before the step boundary `call` reads.
const FIXTURE_BUILTINS = ["page", "context", "request", "env", "requireEnv", "baseURL"] as const;

const STEP_BUILTINS = [...FIXTURE_BUILTINS, "resultOf", "section", "poll", "call", "evidence"] as const;

/** A function whose source destructures `names`. The names are drawn from a
 * closed identifier set, so joining them into the parameter list cannot
 * change what the fixture-name parser reads. */
function destructuring(names: readonly string[]): FixtureFn {
  const pattern = names.length === 0 ? "{}" : `{ ${names.join(", ")} }`;
  return new Function(pattern, "use", "return undefined") as FixtureFn;
}

describe("validateFixtureDefinitions", () => {
  it("reports a fixture that destructures call, for either definition shape", () =>
    hegel.test((tc) => {
      const also = tc.draw(
        gs.arrays(gs.sampledFrom([...FIXTURE_BUILTINS]), {
          minSize: 0,
          maxSize: FIXTURE_BUILTINS.length,
          unique: true,
        }),
      );
      const callProp = tc.draw(gs.booleans()) ? "call: partRunner" : "call";
      const names = tc.draw(gs.booleans()) ? [callProp, ...also] : [...also, callProp];
      const fixtureName = `f${tc.draw(gs.text({ alphabet: "abcxyz", minSize: 1, maxSize: 6 }))}`;
      const fn = destructuring(names);
      const definition: FixtureDefinition = tc.draw(gs.booleans())
        ? [fn, { scope: tc.draw(gs.sampledFrom(["scenario", "process"] as const)) }]
        : fn;
      const issues = validateFixtureDefinitions({ fixtures: { [fixtureName]: definition } });
      const reported = issues.filter(
        (issue) =>
          issue.code === "fixture-structural-violation" &&
          issue.fixture === fixtureName &&
          issue.message.includes('destructures "call"'),
      );
      expect(reported).toHaveLength(1);
    }));

  it("accepts a fixture that names only builtins a fixture can use", () =>
    hegel.test((tc) => {
      const names = tc.draw(
        gs.arrays(gs.sampledFrom([...FIXTURE_BUILTINS]), {
          minSize: 0,
          maxSize: FIXTURE_BUILTINS.length,
          unique: true,
        }),
      );
      const issues = validateFixtureDefinitions({ fixtures: { kept: destructuring(names) } });
      expect(issues).toEqual([]);
    }));

  it("accepts a step that destructures call", () =>
    hegel.test((tc) => {
      const also = tc.draw(
        gs.arrays(gs.sampledFrom([...STEP_BUILTINS]), { minSize: 0, maxSize: 4, unique: true }),
      );
      const names = ["call", ...also.filter((name) => name !== "call")];
      const step = stepWithRun(destructuring(names) as unknown as Step["run"]);
      expect(validateStepFixtures("uses-call", step)).toEqual([]);
    }));
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
