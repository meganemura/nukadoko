import { fixtureReachesBrowser, type FixtureGraph } from "../fixture/graph.js";
import type { TendIssue } from "./types.js";

// Responsibility: docs/spec.md "Tending"'s `fixture-touches-app` finding
// (P5 task spec, scope item 9) — names every `config.fixtures` entry that
// reaches `page`/`context`, directly or through another fixture. This is
// the standing answer to "a fixture that drives Given" (`.claude-team/
// playwright-native-design.md` 4 節): a fixture that logs a user in before
// a step ever runs lets a scenario go green with a precondition the feature
// file itself never named, quietly reversing "the feature file names
// everything that ran". A `drives` declaration was considered and dropped
// (same design doc, same section) — it would add a vocabulary word for
// something already readable from a fixture's own destructuring, and a
// hand-written declaration can lie where a static read cannot.
//
// **Deliberately not a judgment.** `storageState` generation — the most
// common legitimate reason a fixture opens a page at all — is exactly this
// shape, and this finding must not read as "stop doing that". It only ever
// lights it up; a human decides whether a given entry belongs on this list.

export function findFixturesTouchingApp(graph: FixtureGraph): TendIssue[] {
  const issues: TendIssue[] = [];
  for (const [name, node] of graph.nodes) {
    if (node.isBuiltin) {
      continue;
    }
    if (fixtureReachesBrowser(name, graph)) {
      issues.push({
        code: "fixture-touches-app",
        message: `Fixture "${name}" reaches page/context, directly or through another fixture, so it can ` +
          `drive the application before any step names it. Not a verdict: storageState setup is the common ` +
          `legitimate reason a fixture does this.`,
        step: name,
      });
    }
  }
  return issues;
}
