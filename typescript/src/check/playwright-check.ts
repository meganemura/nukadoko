import { PlaywrightMissingError, playwrightPackageMissing } from "../context/load-playwright.js";
import { closeFixtureNames, type FixtureGraph } from "../fixture/graph.js";
import { BROWSER_FIXTURE_NAMES } from "../step/context.js";
import { stepFixtureNames } from "../step/step-fixture-names.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import type { BoundStepLine } from "./feature-check.js";
import type { CheckIssue } from "./types.js";

// Responsibility: the `playwright-missing` finding. A step whose fixture bag
// builds `page`, `context`, `pageAs`, or `request` loads Playwright when it runs, and
// whether Playwright resolves is known before anything runs, so a project
// without it learns at `nuka check` rather than at the first such step of
// `nuka run`. The text is `PlaywrightMissingError`'s, the same one the run
// throws, so the two never describe the problem differently.
//
// The bag is closed with `closeFixtureNames`, the function the resolver
// uses to decide what to build, not with a second traversal. That is what
// keeps an override right: a `config.fixtures` entry named `request` that
// never destructures `request` replaces the builtin, so no Playwright
// request context is built, and no finding is reported for it.
//
// A step file that imports Playwright (`import { expect } from
// "playwright/test"`), itself or through another project file, fails to
// import when the package is missing, before any of the above can be read.
// That failure is the same finding, named at the step file, with one
// message for every file that imports it itself, so `nuka check` prints
// one group with one install line instead of one Node error per file whose
// "Did you mean" hint points at the wrong fix.
//
// A step bound by many feature lines is reported once, at its first line:
// the cause and the fix are the step's, and every further line would repeat
// them.
//
// Only steps a selected feature line binds are judged. A step file that
// defines a browser step nothing runs does not stop a run of a CLI
// scenario, the same rule `analyzeRunSelection` applies to sibling
// scenarios. Compat steps are not judged: their `this` is not read
// statically, so there is nothing certain to report.

/** The call a run names for each browser builtin. `context` is built from
 * `ctx.page()`, so a run names that call for it. */
const BROWSER_BUILTIN_CALLS: Readonly<Record<string, string>> = {
  page: "ctx.page()",
  context: "ctx.page()",
  pageAs: "pageAs()",
};

/** The builtins that load Playwright, and the call a run names for each:
 * every name in `BROWSER_FIXTURE_NAMES`, in its order, then `request`,
 * which loads Playwright without opening a browser. Derived from the shared
 * set rather than listed again, so a new browser builtin cannot reach
 * `needs_browser` and miss this check; one with no call named above fails
 * at load, in every test that imports this module, instead of reporting a
 * guessed call. */
const PLAYWRIGHT_BUILTINS: ReadonlyMap<string, string> = new Map([
  ...[...BROWSER_FIXTURE_NAMES].map((name): [string, string] => {
    const call = BROWSER_BUILTIN_CALLS[name];
    if (call === undefined) {
      throw new Error(`playwright-check.ts names no call for the browser builtin "${name}"`);
    }
    return [name, call];
  }),
  ["request", "ctx.request()"],
]);

/**
 * The Playwright builtins a bag of `names` builds, in `PLAYWRIGHT_BUILTINS`
 * order. `[]` when the names or the graph are not valid: an unknown name or
 * a cycle is already its own `nuka check` error, and guessing past it would
 * report a second finding about a bag that never builds.
 */
export function playwrightBuiltinsOf(names: readonly string[], graph: FixtureGraph): readonly string[] {
  let builtinNames: readonly string[];
  try {
    ({ builtinNames } = closeFixtureNames(names, graph));
  } catch {
    return [];
  }
  return [...PLAYWRIGHT_BUILTINS.keys()].filter((name) => builtinNames.includes(name));
}

/**
 * One `playwright-missing` error per bound typed step whose bag builds a
 * Playwright builtin, when `playwrightInstalled()` says the project has no
 * Playwright. `playwrightInstalled` is called at most once, and only when a
 * step needs it, so a project with no such step never resolves anything.
 */
export function findPlaywrightMissing(
  boundSteps: readonly BoundStepLine[],
  vocabulary: Vocabulary,
  graph: FixtureGraph,
  playwrightInstalled: () => boolean,
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const reported = new Set<string>();
  let installed: boolean | undefined;
  for (const bound of boundSteps) {
    if (reported.has(bound.stepName)) continue;
    const entry = vocabulary.get(bound.stepName);
    if (entry?.kind !== "typed") continue;
    let names: readonly string[];
    try {
      names = [...stepFixtureNames(entry.step)];
    } catch {
      continue; // An unreadable bag is `fixture-structural-violation`.
    }
    const builtins = playwrightBuiltinsOf(names, graph);
    if (builtins.length === 0) continue;
    installed ??= playwrightInstalled();
    if (installed) return [];
    reported.add(bound.stepName);
    const calls = [...new Set(builtins.map((name) => PLAYWRIGHT_BUILTINS.get(name)!))].join(" and ");
    const missing = new PlaywrightMissingError(`${calls} in "${bound.title}"`);
    issues.push({
      code: "playwright-missing",
      message: missing.message,
      file: bound.file,
      ...(bound.line !== undefined ? { line: bound.line } : {}),
      step: bound.stepName,
      do: missing.do,
    });
  }
  return issues;
}

/** The `playwright-missing` finding for a step file that did not import
 * because it imports a Playwright package the project has not installed,
 * or `undefined` for any other import failure. */
export function playwrightImportMissing(failure: {
  readonly filePath: string;
  readonly line?: number;
  readonly missingPackage?: { readonly name: string; readonly importedBy?: string };
}): CheckIssue | undefined {
  const missing = playwrightPackageMissing(failure.missingPackage);
  if (missing === undefined) return undefined;
  return {
    code: "playwright-missing",
    message: missing.message,
    file: failure.filePath,
    ...(failure.line !== undefined ? { line: failure.line } : {}),
    do: missing.do,
  };
}
