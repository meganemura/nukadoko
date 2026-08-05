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
 * Whether destructuring `names` opens a browser. Today this is a direct
 * membership check, `page` or `context`, because those are the only two
 * fixtures that open one, and no fixture can itself depend on another
 * fixture (P5, not yet implemented). Once a user-defined fixture can
 * destructure `page`/`context` from *another* fixture, "needs a browser"
 * stops being a direct check and becomes a transitive closure over the
 * fixture dependency graph — a step that only names a fixture which itself
 * reaches for `page` must still read as `needs_browser: true`. This
 * function is written as the one place that closure will have to be taken,
 * so a caller never has to repeat the membership check by hand.
 */
function opensBrowser(names: readonly string[]): boolean {
  return names.includes("page") || names.includes("context");
}

/** `step`'s own fixture needs, read the same way `check` already reads them,
 * for a caller outside `check` (`nuka steps --json`, this task's spec).
 *
 * @throws whatever `fixtureParameterNames` throws for a `run()` whose first
 * argument can't be read as fixture names at all (not destructured, a
 * default value, a rest property) — see that function's own doc comment.
 */
export function stepNeeds(step: Step): StepNeeds {
  const needs = [...fixtureParameterNames(step.run)].sort();
  return { needs, needsBrowser: opensBrowser(needs) };
}
