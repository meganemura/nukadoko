import type { NukadokoConfig } from "../config/schema.js";
import { BUILTIN_FIXTURE_NAMES } from "../context.js";
import {
  buildFixtureGraph,
  findFixtureCycles,
  findFixtureScopeViolations,
  findPageOverrideUnowned,
  type FixtureGraph,
} from "../fixture/graph.js";
import { fixtureFnOf } from "../fixture/types.js";
import {
  FixtureDefaultValueError,
  FixtureNotDestructuredError,
  FixtureRestParameterError,
  fixtureParameterNames,
  type FixtureConsumer,
} from "./fixture-names.js";
import type { Step } from "./define-step.js";

// Responsibility: the one judgment "does this step's run() ask for fixtures
// nukadoko can actually build" — the fixture-bag counterpart to src/step/
// validate-from.ts's structural `from` check, matched to that same
// checking style. A pure function returning issues, never throwing and never
// printing: `nuka check` (src/check/analyze.ts) folds every issue into its
// own report, and `nuka run`/`nuka do` (src/cli/run.ts, src/cli/do.ts) turn
// a non-empty result into the same setup-phase, no-receipt-written refusal
// ConfigError/a broken `from`/an unknown step name already use — a step
// whose fixtures cannot be resolved never begins executing at all: the same
// "never began" outcome an undefined step already gets, never a step
// failure (docs/spec.md "Context API").
//
// This file was later widened two ways, both additive:
//
//   1. `validateStepFixtures` now takes the *known* fixture-name set as a
//      parameter (`knownFixtureNames`, defaulting to builtins alone, so
//      every existing call site and test keeps compiling unchanged) — a caller
//      that has loaded a config now passes builtins ∪ `config.fixtures`
//      keys, so a step naming a real user fixture is no longer refused as
//      "unknown".
//   2. `validateFixtureDefinitions` is new: the *fixture graph's own*
//      structural findings — a definition destructuring an unknown name
//      (the same judgment as (1), applied to a fixture's own body instead
//      of a step's), a dependency cycle, a `"process"`-scope fixture
//      depending on a `"scenario"`-scope one, and `page` overridden by a fixture that
//      owns neither `page` nor `context` (src/fixture/graph.ts does the
//      actual graph-shape work; this file only turns its findings into the
//      same kind of issue `nuka check`/`nuka run`/`nuka do` already share) —
//      no new check-wiring mechanism, only more findings routed through the
//      one that already exists.
//
// Extraction itself (src/step/fixture-names.ts) can throw for a step (or a
// fixture) whose own function isn't shaped in a way names can be read from
// at all (not destructured, a default value, a rest property); this module
// catches exactly those three error types and turns each into the same kind
// of issue, so every failure family — badly-shaped destructuring, and a
// validly-shaped one naming something nukadoko doesn't have — surfaces
// through the one list a caller has to check.

export interface FixtureIssue {
  /** The step declaring the broken fixture destructuring (a vocabulary
   * name, e.g. "add-todo" — not a file path; the same name `nuka steps`/
   * `nuka describe` use). */
  readonly step: string;
  readonly message: string;
}

const KNOWN_BUILTIN_FIXTURE_NAMES = new Set(BUILTIN_FIXTURE_NAMES);

/** Every valid fixture name for `config` — builtins ∪ every `config.
 * fixtures` key — the one set both `validateStepFixtures` (a step's own
 * usage) and `validateFixtureDefinitions` (a fixture's own dependency on
 * another fixture) validate a destructured name against. Exported so a
 * caller building it once (cli/run.ts's/cli/do.ts's setup phase, `nuka
 * check`) never re-derives `Object.keys(config.fixtures)` a second way. */
export function knownFixtureNames(config: Pick<NukadokoConfig, "fixtures">): ReadonlySet<string> {
  return new Set([...KNOWN_BUILTIN_FIXTURE_NAMES, ...Object.keys(config.fixtures)]);
}

/** The shared judgment both `validateStepFixtures` and
 * `validateFixtureDefinitions` apply — reads `fn`'s own destructured names
 * and checks each against `knownNames`, without ever calling `fn`. Returns
 * plain message strings; each caller attaches its own subject field (`step`
 * vs. `fixture`) and, for definitions, its own `code`. */
function validateFixtureConsumer(fn: FixtureConsumer, knownNames: ReadonlySet<string>): string[] {
  let names: readonly string[];
  try {
    names = fixtureParameterNames(fn);
  } catch (error) {
    if (
      error instanceof FixtureNotDestructuredError ||
      error instanceof FixtureDefaultValueError ||
      error instanceof FixtureRestParameterError
    ) {
      return [error.message];
    }
    throw error;
  }

  const messages: string[] = [];
  for (const name of names) {
    if (!knownNames.has(name)) {
      messages.push(
        `run() destructures unknown fixture "${name}": known fixtures are ${[...knownNames].sort().join(", ")} ` +
          "(a project-defined name must be declared under nukadoko.config.ts's own `fixtures`)",
      );
    }
  }
  return messages;
}

/**
 * Validates one step's own `run` in isolation — structural, scenario-
 * independent, the same "holds or fails the same way everywhere this step
 * is used" property `validateStepFrom` already has. `[]` when `run`'s first
 * argument is a well-formed object-destructuring pattern and every name in
 * it is a member of `knownFixtureNames`.
 *
 * `knownFixtureNames` defaults to builtins alone (the original closed set)
 * so
 * every call site that has not loaded a config — including this file's own
 * earlier tests — keeps compiling and behaving unchanged; a caller that has
 * loaded one passes `knownFixtureNames(config)` (this file's own export)
 * instead, so a step naming a real `config.fixtures` entry is no longer
 * refused as unknown.
 */
export function validateStepFixtures(
  stepName: string,
  step: Step,
  knownNames: ReadonlySet<string> = KNOWN_BUILTIN_FIXTURE_NAMES,
): FixtureIssue[] {
  return validateFixtureConsumer(step.run, knownNames).map((message) => ({ step: stepName, message }));
}

/** Renders `issues` as one line per issue, `"<step>: <message>"` — matches
 * src/step/validate-from.ts's own `formatFromIssues` wording, for the same
 * reason: `nuka do`'s fatal-message rendering shouldn't drift from `nuka
 * run`'s. */
export function formatFixtureIssues(issues: readonly FixtureIssue[]): string {
  return issues.map((issue) => `${issue.step}: ${issue.message}`).join("\n");
}

/** One structural finding about a `config.fixtures` *definition* itself, as
 * opposed to `FixtureIssue` above (a *step's own usage* of one) — `nuka
 * check`'s fixture-* codes: `fixture-cycle`,
 * `fixture-scope-violation`, `page-override-unowned` (src/fixture/graph.ts),
 * plus `fixture-structural-violation` for a fixture whose own destructuring
 * is unknown/malformed — the exact same code `validateStepFixtures`'s own
 * callers (src/check/analyze.ts) already use for a step's own version of
 * that same mistake. */
export interface FixtureDefinitionValidationIssue {
  readonly code: "fixture-structural-violation" | "fixture-cycle" | "fixture-scope-violation" | "page-override-unowned";
  readonly fixture: string;
  readonly message: string;
}

/**
 * Every structural finding about `config.fixtures` itself — never about how
 * any one step uses it (that's `validateStepFixtures`, above, called once
 * per step separately). Building the graph (src/fixture/graph.ts's
 * `buildFixtureGraph`) is cheap and side-effect-free (it only reads each
 * fixture's own destructured names, never calls one), so callers that need
 * both this and the graph itself (src/fixture/resolver.ts, at execution
 * time) are expected to build it once and reuse it — this function takes
 * `config` directly rather than a pre-built graph only because `nuka
 * check`'s own report never needs the graph again afterward.
 */
export function validateFixtureDefinitions(
  config: Pick<NukadokoConfig, "fixtures">,
): FixtureDefinitionValidationIssue[] {
  const known = knownFixtureNames(config);
  const issues: FixtureDefinitionValidationIssue[] = [];
  for (const [name, definition] of Object.entries(config.fixtures)) {
    for (const message of validateFixtureConsumer(fixtureFnOf(definition), known)) {
      issues.push({ code: "fixture-structural-violation", fixture: name, message });
    }
  }
  const graph = buildFixtureGraph(config);
  issues.push(...findFixtureCycles(graph));
  issues.push(...findFixtureScopeViolations(graph));
  issues.push(...findPageOverrideUnowned(graph));
  return issues;
}

/** Renders `issues` as one line per issue, `"<fixture>: <message>"` — the
 * definition-issue counterpart to `formatFixtureIssues` above, same reason:
 * `nuka run`'s/`nuka do`'s setup-phase refusal wording must not drift from
 * `nuka check`'s own report. */
export function formatFixtureDefinitionIssues(issues: readonly FixtureDefinitionValidationIssue[]): string {
  return issues.map((issue) => `${issue.fixture}: ${issue.message}`).join("\n");
}

export { buildFixtureGraph, type FixtureGraph };
