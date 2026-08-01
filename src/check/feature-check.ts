import { CucumberExpression } from "@cucumber/cucumber-expressions";
import { PickleStepType } from "@cucumber/messages";
import { escapeReservedChars } from "../binding/escape-hint.js";
import { createParameterTypeRegistry } from "../binding/registry.js";
import { asObjectShape, isRequiredField } from "../binding/schema-shape.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import type { FeatureFile } from "../feature/load-features.js";
import type { CheckedPattern } from "./binding-check.js";
import type { CheckIssue } from "./types.js";

// Responsibility: match every pickle step (from src/feature/load-features.ts)
// against the vocabulary's patterns (already built once by
// src/check/binding-check.ts, reused here rather than re-parsed) and produce
// this task's spec's per-feature check items: undefined steps (with a
// scaffold hint, plus a near-miss escape hint — see findEscapeHint below),
// ambiguous matches (2+ steps matching one pickle step), Then-position steps
// that mutate, and a table/docstring's "exactly one unconsumed required key"
// rule. Deliberately knows nothing about *why* a pattern failed to build
// (that is binding-check's own issue already) — a pattern missing from
// `patterns` (because it errored there) simply cannot match anything here,
// which is the right behavior: this module must not report the same root
// cause a second time under a different code.

interface MatchResult {
  readonly stepNames: readonly string[];
  /** The (first) pattern of the single step that matched, when exactly one
   * step matched — used for the table/docstring key check below, which
   * needs to know which capture keys that specific match consumed. */
  readonly matched: CheckedPattern | undefined;
}

// Not a general "reserved character" linter (docs/spec.md is explicit that
// one is impossible: optional/alternation syntax is legitimate and intent
// can't be told apart statically). Scoped to the one case where intent is
// no longer ambiguous — this pickle step text matched *nothing*, so trying
// "what if this candidate's bare ( ) / had been escaped" costs nothing and,
// when it turns a non-match into a match, names both the cause (unescaped
// reserved syntax) and the fix in the same breath. Returns undefined (no
// hint) rather than guessing when the escaped variant still doesn't match.
function findEscapeHint(text: string, patterns: readonly CheckedPattern[]): CheckedPattern | undefined {
  const registry = createParameterTypeRegistry();
  for (const candidate of patterns) {
    const source = candidate.expression.source;
    const escaped = escapeReservedChars(source);
    if (escaped === source) {
      continue; // nothing bare to escape; escaping can't change this match
    }
    let escapedExpression: CucumberExpression;
    try {
      escapedExpression = new CucumberExpression(escaped, registry);
    } catch {
      continue; // the escaped variant doesn't even build; no hint from it
    }
    if (escapedExpression.match(text) !== null) {
      return candidate;
    }
  }
  return undefined;
}

function matchPickleStepText(text: string, patterns: readonly CheckedPattern[]): MatchResult {
  const byStep = new Map<string, CheckedPattern>();
  for (const candidate of patterns) {
    if (byStep.has(candidate.stepName)) {
      continue;
    }
    if (candidate.expression.match(text) !== null) {
      byStep.set(candidate.stepName, candidate);
    }
  }
  const stepNames = [...byStep.keys()];
  // The `!` is safe: `stepNames` was just built from `byStep`'s own keys, so
  // when its length is exactly 1 that one key is guaranteed to be there.
  const matched = stepNames.length === 1 ? byStep.get(stepNames[0]!) : undefined;
  return { stepNames, matched };
}

export function checkFeatures(
  features: readonly FeatureFile[],
  vocabulary: Vocabulary,
  patterns: readonly CheckedPattern[],
): CheckIssue[] {
  const issues: CheckIssue[] = [];

  for (const feature of features) {
    const reportedUndefinedText = new Set<string>();

    for (const pickle of feature.pickles) {
      const line = pickle.location?.line;

      for (const step of pickle.steps) {
        const { stepNames, matched } = matchPickleStepText(step.text, patterns);

        if (stepNames.length === 0) {
          if (reportedUndefinedText.has(step.text)) {
            continue;
          }
          reportedUndefinedText.add(step.text);
          const escapeHint = findEscapeHint(step.text, patterns);
          const hintSuffix = escapeHint
            ? ` — hint: would match step "${escapeHint.stepName}" pattern "${escapeHint.pattern}" if its bare ( ) / were escaped — cucumber-expressions reads bare ( ) as optional text and / as alternation`
            : "";
          issues.push({
            code: "undefined-step",
            message: `No step definition matches "${step.text}"; run \`nuka scaffold <name>\` to add one${hintSuffix}`,
            file: feature.relativePath,
            line,
          });
          continue;
        }

        if (stepNames.length > 1) {
          issues.push({
            code: "ambiguous-step",
            message: `"${step.text}" matches more than one step: ${[...stepNames].sort().join(", ")}`,
            file: feature.relativePath,
            line,
          });
          continue;
        }

        // Safe: the `=== 0` and `> 1` cases above both `continue`d, so
        // exactly one name is left here.
        const stepName = stepNames[0]!;
        const entry = vocabulary.get(stepName);
        if (!entry) {
          // Unreachable: stepNames only ever contains names binding-check
          // already resolved from this same vocabulary.
          continue;
        }

        if (step.type === PickleStepType.OUTCOME && entry.step.mutates) {
          issues.push({
            code: "then-mutates",
            message: `Step "${stepName}" is bound in Then position but declares mutates: true`,
            file: feature.relativePath,
            line,
            step: stepName,
          });
        }

        const attachment = step.argument;
        if (matched && (attachment?.dataTable !== undefined || attachment?.docString !== undefined)) {
          const shape = asObjectShape(entry.step.args);
          if (shape) {
            const consumed = new Set(matched.captures.map((c) => c.key));
            const unconsumedRequired = Object.entries(shape)
              .filter(([key, fieldSchema]) => !consumed.has(key) && isRequiredField(fieldSchema))
              .map(([key]) => key);
            if (unconsumedRequired.length !== 1) {
              const detail =
                unconsumedRequired.length === 0
                  ? "every args key is already consumed by named captures"
                  : `${unconsumedRequired.length} args keys are left unconsumed (${unconsumedRequired.join(", ")}); exactly one is required`;
              issues.push({
                code: "table-docstring-key-mismatch",
                message: `Step "${stepName}" has a table/docstring attached but ${detail}`,
                file: feature.relativePath,
                line,
                step: stepName,
              });
            }
          }
        }
      }
    }
  }

  return issues;
}
