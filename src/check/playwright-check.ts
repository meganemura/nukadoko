import { PLAYWRIGHT_VERSION, PlaywrightMissingError } from "../context/load-playwright.js";
import { closeFixtureNames, type FixtureGraph } from "../fixture/graph.js";
import { stepFixtureNames } from "../step/step-fixture-names.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import type { BoundStepLine } from "./feature-check.js";
import type { CheckIssue } from "./types.js";

// Responsibility: the `playwright-missing` finding. A step whose fixture bag
// builds `page`, `context`, or `request` loads Playwright when it runs, and
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
// Only steps a selected feature line binds are judged. A step file that
// defines a browser step nothing runs does not stop a run of a CLI
// scenario, the same rule `analyzeRunSelection` applies to sibling
// scenarios. Compat steps are not judged: their `this` is not read
// statically, so there is nothing certain to report.

/** The builtins that load Playwright, and the call a run names for each.
 * `context` is built from `ctx.page()`, so a run names that call for it. */
const PLAYWRIGHT_BUILTINS: ReadonlyMap<string, string> = new Map([
  ["page", "ctx.page()"],
  ["context", "ctx.page()"],
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
  let installed: boolean | undefined;
  for (const bound of boundSteps) {
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
    const calls = [...new Set(builtins.map((name) => PLAYWRIGHT_BUILTINS.get(name)!))].join(" and ");
    issues.push({
      code: "playwright-missing",
      message: new PlaywrightMissingError(`${calls} in "${bound.title}"`).message,
      file: bound.file,
      ...(bound.line !== undefined ? { line: bound.line } : {}),
      step: bound.stepName,
      do: `npm install -D -E playwright@${PLAYWRIGHT_VERSION}`,
    });
  }
  return issues;
}
