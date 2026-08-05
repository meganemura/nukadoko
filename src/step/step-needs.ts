import { fixtureReachesBrowser, type FixtureGraph } from "../fixture/graph.js";
import { fixtureParameterNames } from "./fixture-names.js";
import type { Step } from "./define-step.js";

// Responsibility: `nuka steps --json`'s own reading of a step's fixture
// destructuring (p4b-steps-needs task spec) — exposure, not judgment. The
// extraction this reads (`fixtureParameterNames`, src/step/fixture-names.ts)
// and the validation that decides whether a name is legitimate
// (`validateStepFixtures`, src/step/validate-fixtures.ts) both already
// exist; this file adds nothing new to either, it only turns the same
// static reading `check` already has into a value a caller outside `check`
// can render. A step whose `run()` can't be parsed at all still throws
// straight out of `fixtureParameterNames`, the same way `nuka steps`
// already fails outright on a step file that fails to import
// (src/discover/discover-steps.ts's default `tolerateImportFailures:
// false`) — one more way a step definition can be broken, not a new
// failure mode this file has to soften.

export interface StepNeeds {
  /** The names `step.run` destructures from its first argument, alphabetized
   * (this task's spec: "ソース上の順ではなく安定した順") rather than left in
   * source order, so two runs of `nuka steps --json` against an unchanged
   * step never disagree over an order nothing depends on. `[]`, never
   * omitted, for a step that needs no fixtures at all: the field's presence
   * is what tells "no needs" apart from "never computed". */
  readonly needs: readonly string[];
  /** Whether opening this step's fixture bag opens a browser. */
  readonly needsBrowser: boolean;
}

/**
 * Whether destructuring `names` opens a browser — a direct membership
 * check, `page` or `context`, the only two fixtures that open one. This is
 * `stepNeeds`'s own fallback for a caller with no fixture graph at all
 * (below): a step whose bag can only ever contain builtins has no
 * transitive path to walk, so the direct check already gives the right
 * answer without needing one.
 */
function opensBrowser(names: readonly string[]): boolean {
  return names.includes("page") || names.includes("context");
}

/** `step`'s own fixture needs, read the same way `check` already reads them,
 * for a caller outside `check` (`nuka steps --json`, this task's spec).
 *
 * `graph` (P5 task spec, scope item 11) is the fixture dependency graph a
 * caller who has loaded a project's config can pass in
 * (src/fixture/graph.ts's `buildFixtureGraph`) — once a user-defined
 * fixture can itself destructure `page`/`context` from *another* fixture,
 * "needs a browser" stops being a direct membership check and becomes a
 * transitive closure over that graph (`fixtureReachesBrowser`): a step that
 * only names a fixture which itself reaches for `page` must still read as
 * `needs_browser: true`. Omitted, this falls back to the direct check
 * above — the exact P4b behavior every pre-P5 call site (and this file's
 * own tests) already depends on, unchanged.
 *
 * @throws whatever `fixtureParameterNames` throws for a `run()` whose first
 * argument can't be read as fixture names at all (not destructured, a
 * default value, a rest property) — see that function's own doc comment.
 */
export function stepNeeds(step: Step, graph?: FixtureGraph): StepNeeds {
  const needs = [...fixtureParameterNames(step.run)].sort();
  const needsBrowser =
    graph !== undefined
      ? needs.some((name) => fixtureReachesBrowser(name, graph))
      : opensBrowser(needs);
  return { needs, needsBrowser };
}
