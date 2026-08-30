import type { CucumberExpression } from "@cucumber/cucumber-expressions";
import { patternLiteralFragments, stripCaptureNames } from "./pattern.js";

// Responsibility: build a quoted variant of an undefined pickle step for
// `nuka check`'s string-parameter near-miss hint. This module only proposes a
// hint after the registered CucumberExpression matches the quoted text. It
// does not participate in normal matching, and it stays silent when more than
// one registered pattern can explain the same undefined line.

export interface QuoteHintPattern {
  readonly matcherKind: "expression" | "regexp";
  readonly stepName: string;
  readonly pattern: string;
  readonly expression?: CucumberExpression;
}

export interface QuoteHint {
  readonly stepName: string;
  readonly pattern: string;
  readonly rewrittenText: string;
}

// A budget of 1,000 fragment placements covers many alternatives in an
// ordinary step line while it puts a small fixed bound on repeated literals.
// If the search reaches the budget, all results are discarded. A partial
// search could make an ambiguous rewrite look unique, which would violate this
// module's rule that a hint must be confirmed rather than guessed.
const MAX_FRAGMENT_PLACEMENTS = 1_000;

function literalFragments(pattern: string): readonly string[] | undefined {
  let stripped;
  try {
    stripped = stripCaptureNames(pattern);
  } catch {
    return undefined;
  }
  if (stripped.captures.length === 0 || stripped.captures.some((capture) => capture.type !== "string")) {
    return undefined;
  }

  return patternLiteralFragments(pattern);
}

export function quoteGapCandidates(text: string, fragments: readonly string[]): readonly string[] {
  if (fragments.slice(1, -1).some((fragment) => fragment === "")) {
    return [];
  }

  const starts: number[] = [];
  const rewritten = new Set<string>();
  let fragmentPlacements = 0;
  let exhausted = false;
  const visit = (index: number, cursor: number): void => {
    if (exhausted) {
      return;
    }
    if (index === fragments.length) {
      let candidate = fragments[0]!;
      for (let fragmentIndex = 0; fragmentIndex < fragments.length - 1; fragmentIndex += 1) {
        const gapStart = starts[fragmentIndex]! + fragments[fragmentIndex]!.length;
        const gap = text.slice(gapStart, starts[fragmentIndex + 1]!);
        if (gap.length === 0) {
          return;
        }
        candidate += `"${gap}"${fragments[fragmentIndex + 1]!}`;
      }
      rewritten.add(candidate);
      return;
    }

    const fragment = fragments[index]!;
    if (index === 0) {
      if (fragment !== "" && !text.startsWith(fragment)) {
        return;
      }
      starts.push(0);
      visit(1, fragment.length);
      starts.pop();
      return;
    }
    if (index === fragments.length - 1) {
      const start = fragment === "" ? text.length : text.length - fragment.length;
      if (start < cursor || !text.endsWith(fragment)) {
        return;
      }
      starts.push(start);
      visit(index + 1, text.length);
      starts.pop();
      return;
    }

    let start = text.indexOf(fragment, cursor);
    while (start !== -1) {
      fragmentPlacements += 1;
      if (fragmentPlacements >= MAX_FRAGMENT_PLACEMENTS) {
        exhausted = true;
        return;
      }
      starts.push(start);
      visit(index + 1, start + fragment.length);
      starts.pop();
      if (exhausted) {
        return;
      }
      start = text.indexOf(fragment, start + 1);
    }
  };
  visit(0, 0);
  return exhausted ? [] : [...rewritten];
}

export function findQuoteHint(text: string, patterns: readonly QuoteHintPattern[]): QuoteHint | undefined {
  const hints: QuoteHint[] = [];
  for (const candidate of patterns) {
    if (candidate.matcherKind !== "expression" || candidate.expression === undefined) {
      continue;
    }
    const fragments = literalFragments(candidate.pattern);
    if (fragments === undefined) {
      continue;
    }
    for (const rewrittenText of quoteGapCandidates(text, fragments)) {
      if (candidate.expression.match(rewrittenText) !== null) {
        hints.push({ stepName: candidate.stepName, pattern: candidate.pattern, rewrittenText });
      }
    }
  }
  return hints.length === 1 ? hints[0] : undefined;
}
