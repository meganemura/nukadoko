import { asObjectShape } from "../binding/schema-shape.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import { attachmentFilledKey } from "../check/from-order.js";
import type { TendIssue } from "./types.js";
import type { StepOccurrences } from "./step-bindings.js";

// Responsibility: docs/spec.md "Tending"'s "A `from` declaration nothing
// exercises" finding — a typed step's `from.<key>` whose declared producer
// never actually gets a chance to supply a value, because every line that
// binds this step already fills that key some other way (a pattern capture,
// or the one table/docstring key a line's attachment resolves to). A step
// never bound anywhere is *not* this finding's business (spec's own line:
// "どの feature にも現れない step は、この所見ではなく次の所見の対象") —
// that is pattern-unbound.ts's question, not this one's.
//
// "Filled some other way" is decided by the exact same two facts
// src/check/from-order.ts already computes to decide whether `from` even
// applies on a given line (that file's own `consumedByCapture`/
// `attachmentFilledKey` check, right before it looks at ordering) — reused
// here via `attachmentFilledKey` itself plus each occurrence's own
// `matched.captures`, never re-derived, so this finding and from-order.ts's
// own "does `from` even apply here" gate can never quietly disagree with
// each other.
//
// Reported as a fact, not a verdict (this task's spec, "制約・前提"): the
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
      const everyOccurrenceFillsKey = stepOccurrences.every((occurrence) => {
        const consumedByCapture = new Set(occurrence.matched.captures.map((capture) => capture.key));
        if (consumedByCapture.has(key)) {
          return true;
        }
        const attachmentFillsKey = attachmentFilledKey(
          occurrence.pickleStep,
          consumedByCapture,
          argsShape,
        );
        return key === attachmentFillsKey;
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
