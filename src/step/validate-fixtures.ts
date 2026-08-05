import { BUILTIN_FIXTURE_NAMES } from "../context.js";
import {
  FixtureDefaultValueError,
  FixtureNotDestructuredError,
  FixtureRestParameterError,
  fixtureParameterNames,
} from "./fixture-names.js";
import type { Step } from "./define-step.js";

// Responsibility: the one judgment "does this step's run() ask for fixtures
// nukadoko can actually build" — the fixture-bag counterpart to src/step/
// validate-from.ts's structural `from` check (p4a-fixture-bag task spec,
// scope item 3: "既存の束縛順検査 src/step/validate-from.ts と同じ流儀に
// すること"). A pure function returning issues, never throwing and never
// printing: `nuka check` (src/check/analyze.ts) folds every issue into its
// own report, and `nuka run`/`nuka do` (src/cli/run.ts, src/cli/do.ts) turn
// a non-empty result into the same setup-phase, no-receipt-written refusal
// ConfigError/a broken `from`/an unknown step name already use — a step
// whose fixtures cannot be resolved never begins executing at all (this
// task's spec: "実行そのものを拒む", never a step failure).
//
// User-defined fixtures do not exist yet (P5, out of this task's scope), so
// the only fixture names that can ever be valid are `StepFixtures`'s own
// closed set (`BUILTIN_FIXTURE_NAMES`, src/context.ts) — every other
// destructured name is refused as unknown. Extraction itself
// (src/step/fixture-names.ts) can also throw for a step whose run() isn't
// shaped in a way names can be read from at all (not destructured, a
// default value, a rest property); this module catches exactly those three
// error types and turns each into the same kind of issue, so both failure
// families (badly-shaped destructuring, and a validly-shaped one naming
// something nukadoko doesn't have) surface through the one list a caller
// has to check.

export interface FixtureIssue {
  /** The step declaring the broken fixture destructuring (a vocabulary
   * name, e.g. "add-todo" — not a file path; the same name `nuka steps`/
   * `nuka describe` use). */
  readonly step: string;
  readonly message: string;
}

const KNOWN_FIXTURE_NAMES = new Set(BUILTIN_FIXTURE_NAMES);

/**
 * Validates one step's own `run` in isolation — structural, scenario-
 * independent, the same "holds or fails the same way everywhere this step
 * is used" property `validateStepFrom` already has. `[]` when `run`'s first
 * argument is a well-formed object-destructuring pattern and every name in
 * it is one of `StepFixtures`'s own members.
 */
export function validateStepFixtures(stepName: string, step: Step): FixtureIssue[] {
  let names: readonly string[];
  try {
    names = fixtureParameterNames(step.run);
  } catch (error) {
    if (
      error instanceof FixtureNotDestructuredError ||
      error instanceof FixtureDefaultValueError ||
      error instanceof FixtureRestParameterError
    ) {
      return [{ step: stepName, message: error.message }];
    }
    throw error;
  }

  const issues: FixtureIssue[] = [];
  for (const name of names) {
    if (!KNOWN_FIXTURE_NAMES.has(name)) {
      issues.push({
        step: stepName,
        message:
          `run() destructures unknown fixture "${name}": nukadoko's builtin fixtures are: ` +
          `${[...KNOWN_FIXTURE_NAMES].join(", ")} (user-defined fixtures are not implemented yet)`,
      });
    }
  }
  return issues;
}

/** Renders `issues` as one line per issue, `"<step>: <message>"` — matches
 * src/step/validate-from.ts's own `formatFromIssues` wording, for the same
 * reason: `nuka do`'s fatal-message rendering shouldn't drift from `nuka
 * run`'s. */
export function formatFixtureIssues(issues: readonly FixtureIssue[]): string {
  return issues.map((issue) => `${issue.step}: ${issue.message}`).join("\n");
}
