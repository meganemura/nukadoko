import { fixtureParameterNames } from "./fixture-names.js";
import type { Step } from "./define-step.js";

// Responsibility: a step's full fixture-name closure — its own destructured
// names union every part it declares, closed transitively over `parts`
// (docs/spec.md "Parts": "a step's needs are its own names together with
// the names of everything it declares, closed transitively, the same way a
// user-defined fixture's own reach for `page` is already closed"). Read
// statically, the same way `fixtureParameterNames` itself is: this never
// calls a step's own `run`, only its `.parts` declaration and its run's own
// destructuring pattern.
//
// Two callers need this exact closure: src/run/run-scenario.ts and src/
// cli/do.ts pass it to `resolveFixtures` in place of a step's own bare
// `fixtureParameterNames(step.run)`, so a composite step's fixture bag is
// built with every resource any of its parts (at any depth) will need
// already resolved — a browser launches before `run()` starts whenever a
// part reaches for `page`, even on a branch that never calls it, matching
// the declared-before-either-function-runs timing docs/spec.md "Parts"
// describes. src/step/step-needs.ts's `stepNeeds` uses the same closure so
// `nuka steps --json`'s `needs`/`needs_browser` account for a part's own
// needs too.
//
// `parts` is a static declaration, not a runtime call graph, so it can
// contain a cycle a step author wrote by mistake (`nuka check` reports that
// separately) — `visited` below is what keeps this walk from looping
// forever over one rather than reporting it itself; this file has no
// business deciding whether a cycle is an error.

/**
 * `step`'s own destructured fixture names, unioned with every part's
 * (recursively) — deduplicated, in first-seen order. Safe against a `parts`
 * cycle: a step already on the current path is skipped rather than
 * revisited.
 *
 * @throws whatever `fixtureParameterNames` throws for a `run()` (this
 * step's own, or any part's) whose first argument can't be read as fixture
 * names at all — see that function's own doc comment.
 */
export function stepFixtureNames(step: Step): readonly string[] {
  const names = new Set<string>();
  const visited = new Set<Step>();

  function visit(current: Step): void {
    if (visited.has(current)) {
      return;
    }
    visited.add(current);
    for (const name of fixtureParameterNames(current.run)) {
      names.add(name);
    }
    for (const part of current.parts) {
      visit(part);
    }
  }

  visit(step);
  return [...names];
}
