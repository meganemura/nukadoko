import { asObjectShape } from "../binding/schema-shape.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import type { TendIssue } from "./types.js";
import type { StepOccurrences } from "./step-bindings.js";

// Responsibility: docs/spec.md "Tending"'s "A `from` declaration nothing
// exercises" finding — a typed step's `from.<key>` whose declared producer
// never actually gets a chance to supply a value, because every line that
// binds this step already fills that key with a pattern capture. A step
// never bound anywhere is *not* this finding's business —
// that is pattern-unbound.ts's question, not this one's.
//
// A capture is the only other filler. A table/docstring is placed against
// the keys neither a capture nor `from` speaks for (src/run/match-step.ts's
// `bindStepArgs`, mirrored by src/check/from-order.ts's own gate), so it can
// never land on a `from` key; that rule is what lets one line take a key
// from an earlier step and another from its attachment. "Filled by a
// capture" is read from each occurrence's own `matched.captures`, the same
// fact from-order.ts reads, never re-derived, so this finding and that gate
// can never quietly disagree with each other.
//
// Reported as a fact, not a verdict: the
// message never says to delete the declaration — `nuka do --use` can still
// reach it (docs/spec.md "Tending": "the declaration may still be reached
// through `nuka do --use`").

export function findUnusedFromDeclarations(vocabulary: Vocabulary, occurrences: StepOccurrences): TendIssue[] {
  const issues: TendIssue[] = [];

  for (const entry of vocabulary.values()) {
    if (entry.kind !== "typed") {
      continue; // Compat has no `from` at all.
    }
    const fromEntries = Object.entries(entry.step.from);
    if (fromEntries.length === 0) {
      continue;
    }
    const stepOccurrences = occurrences.get(entry.name);
    if (stepOccurrences === undefined || stepOccurrences.length === 0) {
      continue; // Never bound anywhere — pattern-unbound.ts's finding, not this one's.
    }

    const argsShape = asObjectShape(entry.step.args);

    for (const [key] of fromEntries) {
      // A capture of the same key is the only thing that fills a `from` key
      // some other way: a table/docstring is placed against the keys
      // neither a capture nor `from` speaks for (src/run/match-step.ts's
      // `bindStepArgs`), so it can never land on this one. `argsShape` is
      // still read so a non-object `args` keeps this finding silent, the
      // same way `attachmentFilledKey` keeps quiet for it.
      const everyOccurrenceFillsKey =
        argsShape !== undefined &&
        stepOccurrences.every((occurrence) => {
          const consumedByCapture = new Set(occurrence.matched.captures.map((capture) => capture.key));
          return consumedByCapture.has(key);
        });

      if (everyOccurrenceFillsKey) {
        issues.push({
          code: "from-unused",
          message: `Step "${entry.name}"'s from.${key} declares a producer, but every bound occurrence of this step already fills "${key}" from a pattern capture or table/docstring. That producer has never supplied it. Still reachable through \`nuka do --use\`; this is a fact, not a verdict on whether to remove it.`,
          step: entry.name,
        });
      }
    }
  }

  return issues;
}
