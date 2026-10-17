import path from "node:path";
import type { TypedVocabularyEntry, Vocabulary } from "../discover/discover-steps.js";
import type { FeatureFile } from "../feature/load-features.js";
import type { CheckedPattern } from "./binding-check.js";
import { createStepTextMatcher } from "./feature-check.js";

// Responsibility: which typed steps declare a pattern that no feature line
// in the project binds, and the sentence `undefined-step` appends to name
// them. `nuka tend`'s `pattern-unbound` note (src/tend/pattern-unbound.ts)
// and `nuka check`'s `undefined-step` suffix both read the list from here,
// so the two commands name the same steps.
//
// The suffix exists because a renamed sentence or a renamed pattern leaves
// one feature line undefined and one step unbound at the same time. Without
// it, the only hint `check` printed was "run nuka scaffold", which writes a
// duplicate of a step that already exists. Both facts are exact; whether the
// unbound step was the one meant is the reader's call, so the scaffold hint
// stays beside it.
//
// The set is always judged on every feature the project scans (featuresDir,
// additionalFeatureDirs, and oaths, the files `tend` reads), never on the
// files a target selected. Judged on a selection, a step bound in a file
// outside it would be called unbound, the same undefined line would read
// differently under `nuka check a.feature` and `nuka check a.feature
// b.feature`, and a multi-target report would stop being the union of each
// target's own report.

/** Typed steps with at least one pattern and no name in `boundNames`, in
 * vocabulary order. Compat steps are left out: an unused compat glue file
 * mid-migration is the expected state (docs/spec.md "Compat steps"). */
export function findUnboundPatternedEntries(
  vocabulary: Vocabulary,
  boundNames: ReadonlySet<string>,
): TypedVocabularyEntry[] {
  const unbound: TypedVocabularyEntry[] = [];
  for (const entry of vocabulary.values()) {
    if (entry.kind === "typed" && entry.step.patterns.length > 0 && !boundNames.has(entry.name)) {
      unbound.push(entry);
    }
  }
  return unbound;
}

/** The step file as a reader opens it: relative to the project root, with
 * `/` separators so the text is the same on every platform. */
export function rootRelativeStepFile(rootDir: string, entry: { readonly filePath: string }): string {
  return path.relative(rootDir, path.resolve(rootDir, entry.filePath)).split(path.sep).join("/");
}

/** How many unbound steps the suffix names before it counts the rest. Three
 * keeps an `undefined-step` line readable on a project with many unbound
 * steps, while a rename (the case this exists for) leaves one. */
export const UNBOUND_NAMED_LIMIT = 3;

/** Names of the steps some line resolves to exactly one of. A line that
 * matches two patterns binds neither, the same rule `nuka tend` and `nuka
 * run` apply. */
export function boundStepNames(features: readonly FeatureFile[], patterns: readonly CheckedPattern[]): Set<string> {
  const match = createStepTextMatcher(patterns);
  const bound = new Set<string>();
  for (const feature of features) {
    for (const pickle of feature.pickles) {
      for (const step of pickle.steps) {
        const { stepNames } = match(step.text);
        if (stepNames.length === 1) {
          bound.add(stepNames[0]!);
        }
      }
    }
  }
  return bound;
}

/** `""` when nothing is unbound, so a project with no unbound patterned step
 * keeps the `undefined-step` message it always had. */
export function unboundPatternedSuffix(unbound: readonly TypedVocabularyEntry[], rootDir: string): string {
  if (unbound.length === 0) {
    return "";
  }
  const named = unbound.slice(0, UNBOUND_NAMED_LIMIT).map((entry) => {
    const patterns = entry.step.patterns.map((pattern) => `"${pattern}"`).join(" or ");
    return `${entry.name} (${patterns}, ${rootRelativeStepFile(rootDir, entry)})`;
  });
  const rest = unbound.length - named.length;
  const list = rest > 0 ? `${named.join(", ")}, and ${rest} more` : named.join(", ");
  return `; patterned steps no scanned feature line binds: ${list}`;
}
