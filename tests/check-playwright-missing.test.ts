import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { findPlaywrightMissing, playwrightImportMissing } from "../src/check/playwright-check.js";
import type { BoundStepLine } from "../src/check/feature-check.js";
import { PLAYWRIGHT_VERSION } from "../src/context/load-playwright.js";
import type { Vocabulary, VocabularyEntry } from "../src/discover/discover-steps.js";
import { buildFixtureGraph } from "../src/fixture/graph.js";
import { defineStep } from "../src/step/define-step.js";
import type { FixtureDefinition } from "../src/step/fixture-types.js";

// Responsibility: the `playwright-missing` judgment in
// src/check/playwright-check.ts, called directly with a fixture graph built
// from real `config.fixtures` functions and with Playwright's presence
// injected. tests/optional-playwright.test.ts covers the same finding end to
// end through `nuka check` and `nuka run` in a project that really lacks
// Playwright.

const PLAYWRIGHT_BUILTINS = new Set(["page", "context", "request"]);
const OTHER_BUILTINS = ["env", "scratch", "baseURL"];

/** A function whose first parameter destructures `names`, which is all the
 * fixture graph and `stepFixtureNames` read from it. */
function destructuring(names: readonly string[], withUse: boolean): (...args: never[]) => unknown {
  const params = `{ ${names.join(", ")} }${withUse ? ", use" : ""}`;
  return new Function(`return async (${params}) => { void 0; };`)() as (...args: never[]) => unknown;
}

function stepUsing(names: readonly string[]) {
  return defineStep({
    description: "a step",
    args: z.object({}),
    run: destructuring(names, false) as never,
  });
}

function vocabularyOf(steps: Record<string, readonly string[]>): Vocabulary {
  const entries: [string, VocabularyEntry][] = Object.entries(steps).map(([name, names]) => [
    name,
    { kind: "typed", name, filePath: `/p/features/steps/${name}.ts`, step: stepUsing(names) },
  ]);
  return new Map(entries);
}

function bound(stepName: string, line = 3): BoundStepLine {
  return { stepName, file: "features/a.feature", line, title: `When ${stepName} happens` };
}

function fixtures(definitions: Record<string, readonly string[]>): Record<string, FixtureDefinition> {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, deps]) => [name, destructuring(deps, true) as FixtureDefinition]),
  );
}

describe("findPlaywrightMissing", () => {
  it("reports a request step with the run's own message, file, line, and step", () => {
    const issues = findPlaywrightMissing(
      [bound("fetch")],
      vocabularyOf({ fetch: ["request"] }),
      buildFixtureGraph({ fixtures: {} }),
      () => false,
    );
    expect(issues).toEqual([
      {
        code: "playwright-missing",
        message:
          'ctx.request() in "When fetch happens" needs "playwright", and this project has not installed it; ' +
          `nukadoko is tested against playwright@${PLAYWRIGHT_VERSION}`,
        file: "features/a.feature",
        line: 3,
        step: "fetch",
        do: `npm install -D -E playwright@${PLAYWRIGHT_VERSION}`,
      },
    ]);
  });

  it("names ctx.page() once for a step that takes page and context, and both calls beside request", () => {
    const issues = findPlaywrightMissing(
      [bound("browse"), bound("both", 7)],
      vocabularyOf({ browse: ["context", "page"], both: ["page", "request"] }),
      buildFixtureGraph({ fixtures: {} }),
      () => false,
    );
    expect(issues.map((issue) => issue.message.split(" needs ")[0])).toEqual([
      'ctx.page() in "When browse happens"',
      'ctx.page() and ctx.request() in "When both happens"',
    ]);
  });

  it("reports a step once, at the first of the lines that bind it", () => {
    const issues = findPlaywrightMissing(
      [bound("fetch", 3), bound("browse", 5), bound("fetch", 9)],
      vocabularyOf({ fetch: ["request"], browse: ["page"] }),
      buildFixtureGraph({ fixtures: {} }),
      () => false,
    );
    expect(issues.map((issue) => [issue.step, issue.line])).toEqual([
      ["fetch", 3],
      ["browse", 5],
    ]);
  });

  it("reports a step whose user fixture destructures request", () => {
    const issues = findPlaywrightMissing(
      [bound("make-tenant")],
      vocabularyOf({ "make-tenant": ["tenant"] }),
      buildFixtureGraph({ fixtures: fixtures({ tenant: ["request"] }) }),
      () => false,
    );
    expect(issues.map((issue) => issue.step)).toEqual(["make-tenant"]);
  });

  it("reports nothing for a request fixture overridden without Playwright", () => {
    const issues = findPlaywrightMissing(
      [bound("fetch")],
      vocabularyOf({ fetch: ["request"] }),
      buildFixtureGraph({ fixtures: fixtures({ request: ["env"] }) }),
      () => false,
    );
    expect(issues).toEqual([]);
  });

  it("reports nothing, and resolves nothing, for a command-line step", () => {
    let calls = 0;
    const issues = findPlaywrightMissing(
      [bound("run-cli")],
      vocabularyOf({ "run-cli": ["scratch"] }),
      buildFixtureGraph({ fixtures: {} }),
      () => {
        calls++;
        return false;
      },
    );
    expect(issues).toEqual([]);
    expect(calls).toBe(0);
  });

  it("reports nothing when Playwright resolves, and asks once", () => {
    let calls = 0;
    const issues = findPlaywrightMissing(
      [bound("fetch"), bound("browse")],
      vocabularyOf({ fetch: ["request"], browse: ["page"] }),
      buildFixtureGraph({ fixtures: {} }),
      () => {
        calls++;
        return true;
      },
    );
    expect(issues).toEqual([]);
    expect(calls).toBe(1);
  });

  it("reports nothing for a compat step, whose world is not read statically", () => {
    const vocabulary: Vocabulary = new Map([
      [
        "compat: a page",
        {
          kind: "compat",
          name: "compat: a page",
          filePath: "/p/features/steps/legacy.js",
          compat: { keyword: "Given", pattern: "a page", patternSource: "a page", fn: () => {}, registrationOrder: 0 },
        },
      ],
    ]);
    expect(findPlaywrightMissing([bound("compat: a page")], vocabulary, buildFixtureGraph({ fixtures: {} }), () => false)).toEqual([]);
  });

  // The oracle reads the layering rule directly: a name resolves to the
  // user fixture of that name when there is one, except inside that
  // fixture's own parameters, where it resolves to the builtin it replaces.
  it("reports a step exactly when its fixture closure builds page, context, or request and Playwright is missing", () =>
    hegel.test(
      (tc) => {
        const userCount = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
        const overrideRequest = tc.draw(gs.booleans());
        const builtins = [...PLAYWRIGHT_BUILTINS, ...OTHER_BUILTINS];
        const definitions: Record<string, string[]> = {};
        if (overrideRequest) {
          definitions.request = [...tc.draw(gs.sets(gs.sampledFrom(builtins), { maxSize: 3 }))].sort();
        }
        const userNames: string[] = [];
        for (let i = 0; i < userCount; i++) {
          // Each fixture depends only on builtins and earlier fixtures, so
          // the graph has no cycle; a cycle is its own check error.
          const pool = [...builtins, ...userNames];
          definitions[`f${i}`] = [...tc.draw(gs.sets(gs.sampledFrom(pool), { maxSize: 3 }))].sort();
          userNames.push(`f${i}`);
        }
        const stepPool = [...builtins, ...userNames];
        const stepCount = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
        const steps: Record<string, string[]> = {};
        for (let i = 0; i < stepCount; i++) {
          steps[`s${i}`] = [...tc.draw(gs.sets(gs.sampledFrom(stepPool), { maxSize: 3 }))].sort();
        }
        const installed = tc.draw(gs.booleans());

        function reaches(name: string, from: string | undefined): boolean {
          if (name !== from && definitions[name] !== undefined) {
            return definitions[name]!.some((dep) => reaches(dep, name));
          }
          return PLAYWRIGHT_BUILTINS.has(name);
        }
        const expected = installed
          ? []
          : Object.entries(steps)
              .filter(([, names]) => names.some((name) => reaches(name, undefined)))
              .map(([name]) => name);

        const issues = findPlaywrightMissing(
          Object.keys(steps).map((name) => bound(name)),
          vocabularyOf(steps),
          buildFixtureGraph({ fixtures: fixtures(definitions) }),
          () => installed,
        );
        expect(issues.map((issue) => issue.step)).toEqual(expected);
        expect(issues.every((issue) => issue.code === "playwright-missing")).toBe(true);
      },
      { testCases: 200 },
    ));
});

describe("playwrightImportMissing", () => {
  it("reports a step file whose own Playwright import is missing, with one message for every file", () => {
    expect(playwrightImportMissing({ filePath: "e2e/steps/a.ts", missingPackage: { name: "playwright" } })).toEqual({
      code: "playwright-missing",
      message:
        'the step file imports "playwright", and this project has not installed it, so the file does not import; ' +
        `nukadoko is tested against playwright@${PLAYWRIGHT_VERSION}`,
      file: "e2e/steps/a.ts",
      do: `npm install -D -E playwright@${PLAYWRIGHT_VERSION}`,
    });
    expect(playwrightImportMissing({ filePath: "e2e/steps/b.ts", line: 2, missingPackage: { name: "@playwright/test" } })).toMatchObject({
      file: "e2e/steps/b.ts",
      line: 2,
      do: `npm install -D -E @playwright/test@${PLAYWRIGHT_VERSION}`,
    });
  });

  it("reports a step file that reaches Playwright through another file, naming that file", () => {
    expect(
      playwrightImportMissing({ filePath: "e2e/steps/open.ts", missingPackage: { name: "playwright", importedBy: "e2e/steps/run.ts" } }),
    ).toEqual({
      code: "playwright-missing",
      message:
        'the step file imports "playwright" through e2e/steps/run.ts, and this project has not installed it, so the file does not import; ' +
        `nukadoko is tested against playwright@${PLAYWRIGHT_VERSION}`,
      file: "e2e/steps/open.ts",
      do: `npm install -D -E playwright@${PLAYWRIGHT_VERSION}`,
    });
  });

  it("leaves any other import failure alone", () => {
    expect(playwrightImportMissing({ filePath: "a.ts" })).toBeUndefined();
    expect(playwrightImportMissing({ filePath: "a.ts", missingPackage: { name: "playwright-extra" } })).toBeUndefined();
  });
});
