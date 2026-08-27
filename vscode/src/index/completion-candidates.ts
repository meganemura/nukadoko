// Responsibility: turn extracted patterns into insertable completion text.
// A compat pattern given as a RegExp has no literal wording worth offering
// (there is no string a completion could insert that still means what the
// regexp matches), so those are dropped here; a "typed" pattern is always a
// cucumber-expression string already (src/step/define-step.ts's
// StepDefinitionInput), never a RegExp, so this filter only ever removes
// compat/regexp entries in practice.
import { basename } from "node:path";
import type { ExtractedPattern } from "../extraction/index.js";

export interface CompletionCandidate {
  readonly insertText: string;
  readonly detail: string;
}

export function buildCompletionCandidates(
  patterns: readonly ExtractedPattern[],
): readonly CompletionCandidate[] {
  const seen = new Set<string>();
  const candidates: CompletionCandidate[] = [];

  for (const pattern of patterns) {
    if (typeof pattern.pattern !== "string") {
      continue;
    }
    const insertText = pattern.pattern;
    if (seen.has(insertText)) {
      continue;
    }
    seen.add(insertText);
    candidates.push({ insertText, detail: basename(pattern.declarationFile) });
  }

  return candidates;
}
