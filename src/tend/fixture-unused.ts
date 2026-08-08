import type { Vocabulary } from "../discover/discover-steps.js";
import { closeFixtureNames, type FixtureGraph } from "../fixture/graph.js";
import { fixtureParameterNames } from "../step/fixture-names.js";
import type { TendIssue } from "./types.js";

// Responsibility: docs/spec.md "Tending"'s `fixture-unused` finding —
// a `config.fixtures` entry no typed step requires,
// directly or transitively through another fixture. Reported as a fact, the
// same "note, not a verdict" convention every other tend finding follows
// (docs/spec.md "Tending"): an unused fixture is not automatically dead —
// `nuka do`'s own fixture resolution can still reach it the same way
// src/tend/from-unused.ts's own finding notes `nuka do --use` can still
// reach an unused `from` declaration — this only says nothing *currently
// bound* asks for it.
//
// "Transitively" matters: a fixture only ever reached as another fixture's
// own dependency (never directly destructured by any step) is still in
// use — `closeFixtureNames` (src/fixture/graph.ts) is what computes that
// full reachable set for a step's own requested names, the exact same
// function src/fixture/resolver.ts calls at execution time, so "used" here
// can never quietly disagree with what actually gets built.
//
// A step whose own `run()` can't be read as fixture names at all (not
// destructured, a default value, a rest property) throws out of
// `fixtureParameterNames` — the same "structural violation" src/check/
// analyze.ts already reports as an error; this finding simply skips that
// step's own contribution to the reachable set rather than throwing itself,
// since one broken step must not take down every other fixture's own
// unused-or-not verdict (the same tolerance src/tend/analyze.ts's own
// `discoverSteps({ tolerateImportFailures: true })` already extends to a
// step file that fails to import at all).

export function findUnusedFixtures(vocabulary: Vocabulary, graph: FixtureGraph): TendIssue[] {
  const reachable = new Set<string>();
  for (const entry of vocabulary.values()) {
    if (entry.kind !== "typed") {
      continue; // Compat has no fixture bag at all.
    }
    let names: readonly string[];
    try {
      names = fixtureParameterNames(entry.step.run);
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

  const issues: TendIssue[] = [];
  for (const [name, node] of graph.nodes) {
    if (node.isBuiltin || reachable.has(name)) {
      continue;
    }
    issues.push({
      code: "fixture-unused",
      message: `Fixture "${name}" is declared under nukadoko.config.ts's own \`fixtures\`, but no typed step ` +
        `requires it, directly or through another fixture. Still reachable through \`nuka do\`; this is a fact, ` +
        `not a verdict on whether to remove it.`,
      step: name,
    });
  }
  return issues;
}
