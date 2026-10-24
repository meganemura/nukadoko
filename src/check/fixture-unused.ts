import type { Vocabulary } from "../discover/discover-steps.js";
import { closeFixtureNames, type FixtureGraph } from "../fixture/graph.js";
import { fixtureSourceOf } from "../step/define-step.js";
import { fixtureParameterNames } from "../step/fixture-names.js";
import type { CheckIssue } from "./types.js";

// Responsibility: the `fixture-unused` note, a `config.fixtures` entry no
// typed step requires, directly or transitively through another fixture.
// Boundary: it reports a fact, not a verdict. An unused fixture is not
// automatically dead: `nuka do` resolves fixtures the same way and can still
// reach it, just as `nuka do --use` can still reach an unused `from`
// declaration (src/check/from-unused.ts). This only says nothing *currently
// bound* asks for it.
//
// "Transitively" matters: a fixture only ever reached as another fixture's
// dependency (never directly destructured by any step) is still in use.
// `closeFixtureNames` (src/fixture/graph.ts) computes that full reachable
// set for a step's requested names, the same function src/fixture/resolver.ts
// calls at execution time, so "used" here cannot disagree with what actually
// gets built.
//
// A step whose `run()` cannot be read as fixture names at all (not
// destructured, a default value, a rest property) throws out of
// `fixtureParameterNames`, which src/check/analyze.ts already reports as an
// error. This note skips that step's contribution to the reachable set
// rather than throwing, since one broken step must not take down every other
// fixture's verdict (the same tolerance `discoverSteps({
// tolerateImportFailures: true })` extends to a step file that fails to
// import).

export function findUnusedFixtures(vocabulary: Vocabulary, graph: FixtureGraph): CheckIssue[] {
  const reachable = new Set<string>();
  for (const entry of vocabulary.values()) {
    if (entry.kind !== "typed") {
      continue; // Compat has no fixture bag at all.
    }
    let names: readonly string[];
    try {
      names = fixtureParameterNames(fixtureSourceOf(entry.step));
    } catch {
      continue; // Reported as fixture-structural-violation by `nuka check`.
    }
    let userOrder: readonly string[];
    try {
      userOrder = closeFixtureNames(names, graph).userOrder;
    } catch {
      // A cycle or unknown name here is already `nuka check`'s own
      // fixture-cycle/fixture-structural-violation finding; this note
      // simply has nothing further to say about that step's own reach.
      continue;
    }
    for (const name of userOrder) {
      reachable.add(name);
    }
  }

  const issues: CheckIssue[] = [];
  for (const [name, node] of graph.nodes) {
    if (node.isBuiltin || reachable.has(name)) {
      continue;
    }
    issues.push({
      code: "fixture-unused",
      message: `Fixture "${name}" is declared under nukadoko.config.ts's own \`fixtures\`, but no typed step ` +
        `requires it, directly or through another fixture. Still reachable through \`nuka do\`; this is a fact, ` +
        `not a verdict on whether to remove it.`,
      fixture: name,
    });
  }
  return issues;
}
