import type { Vocabulary } from "../discover/discover-steps.js";
import { isStep, type Step } from "../step/define-step.js";

// Responsibility: the two `parts` (docs/spec.md "Parts") findings that are
// facts about the whole vocabulary graph, not about one step's own
// declaration read in isolation -- the graph-level counterpart to
// src/step/validate-parts.ts's own per-step structural check, matching
// src/check/from-order.ts's own split between a structural check
// (validate-from.ts) and a cross-step judgment (this kind of module).
//
// Both walks skip an edge to a part that isn't itself a registered `Step`:
// that mistake already has its own owner (validate-parts.ts's
// `part-structural-violation`), and reporting it a second time here, under
// a placeholder name, would be the same root cause surfacing twice under
// two different codes -- the same "one broken thing, one finding" reasoning
// src/check/analyze.ts already applies when it suppresses undefined-step
// behind an import failure it can already explain.

function stepNameOf(vocabulary: Vocabulary): Map<Step, string> {
  const names = new Map<Step, string>();
  for (const entry of vocabulary.values()) {
    if (entry.kind === "typed") {
      names.set(entry.step, entry.name);
    }
  }
  return names;
}

export interface PartCycleIssue {
  readonly code: "part-cycle";
  /** The step whose own traversal first closed the loop -- not necessarily
   * "the top" of anything, since a cycle has no start; matches
   * src/fixture/graph.ts's own `findFixtureCycles`, which attributes the
   * same way for the same reason. */
  readonly step: string;
  readonly message: string;
}

/**
 * Every cycle in the `parts` graph -- a step that reaches itself, directly
 * or through several other steps' own `parts`. Never closes into a fixture
 * bag or a terminating run (docs/spec.md "Parts"), so this is always an
 * error, never a guess. Standard three-color DFS, the same algorithm and
 * the same "a node already fully explored is never re-entered, so the same
 * cycle is reported once" property src/fixture/graph.ts's own
 * `findFixtureCycles` already has for the unrelated fixture-dependency
 * graph.
 */
export function findPartCycles(vocabulary: Vocabulary): PartCycleIssue[] {
  const names = stepNameOf(vocabulary);
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<Step, number>();
  for (const step of names.keys()) {
    color.set(step, WHITE);
  }

  const issues: PartCycleIssue[] = [];

  function visit(step: Step, stack: Step[]): void {
    color.set(step, GRAY);
    stack.push(step);
    for (const part of step.parts) {
      if (!isStep(part) || !names.has(part)) {
        continue; // Not a registered Step at all -- validate-parts.ts's own finding.
      }
      const partColor = color.get(part);
      if (partColor === GRAY) {
        const startIndex = stack.indexOf(part);
        const cycle = [...stack.slice(startIndex), part];
        const cycleNames = cycle.map((entry) => names.get(entry)!);
        issues.push({
          code: "part-cycle",
          step: cycleNames[0]!,
          message: `part cycle: ${cycleNames.join(" -> ")}. A cycle here can never close into a fixture bag or a terminating run (docs/spec.md "Parts")`,
        });
      } else if (partColor === WHITE) {
        visit(part, stack);
      }
    }
    stack.pop();
    color.set(step, BLACK);
  }

  for (const step of names.keys()) {
    if (color.get(step) === WHITE) {
      visit(step, []);
    }
  }

  return issues;
}

export interface PartMutatesContradictionIssue {
  readonly code: "part-mutates-contradiction";
  readonly step: string;
  /** Absolute -- the declaring step's own file, same convention
   * TypedVocabularyEntry.filePath already uses; src/check/analyze.ts
   * relativizes it the same way it already does for every other finding
   * built from a vocabulary entry. */
  readonly filePath: string;
  readonly message: string;
}

/**
 * Every step that declares `mutates: false` while also declaring a part
 * that declares `mutates: true` -- a contradiction, since `mutates` says
 * the step changes state anywhere it touches, and a part it may call is
 * somewhere it touches (docs/spec.md "Parts"). Checked one level deep only,
 * on purpose: this runs over *every* step in the vocabulary, so a
 * contradiction buried two parts down is caught by this same check running
 * against the step in between, not by this function walking further down
 * (docs/spec.md "Parts": "That check is what keeps `then-mutates` local").
 * An unregistered/non-Step part is left alone here too, for the same reason
 * `findPartCycles` above skips it: `part-structural-violation` already owns
 * that finding.
 */
export function findPartMutatesContradictions(vocabulary: Vocabulary): PartMutatesContradictionIssue[] {
  const names = stepNameOf(vocabulary);
  const issues: PartMutatesContradictionIssue[] = [];

  for (const entry of vocabulary.values()) {
    if (entry.kind !== "typed" || entry.step.mutates) {
      continue; // mutates: true has nothing to contradict; compat has no parts at all.
    }
    for (const part of entry.step.parts) {
      if (!isStep(part) || !names.has(part) || !part.mutates) {
        continue;
      }
      const partName = names.get(part)!;
      issues.push({
        code: "part-mutates-contradiction",
        step: entry.name,
        filePath: entry.filePath,
        message:
          `Step "${entry.name}" declares mutates: false, but declares part "${partName}", which declares ` +
          `mutates: true. A step's mutates flag covers everywhere it touches, and a part it may call is ` +
          `part of that reach (docs/spec.md "Parts")`,
      });
    }
  }

  return issues;
}
