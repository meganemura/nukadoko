import { CucumberExpression } from "@cucumber/cucumber-expressions";
import { PickleStepType } from "@cucumber/messages";
import { escapeReservedChars } from "../binding/escape-hint.js";
import { createParameterTypeRegistry } from "../binding/registry.js";
import { asObjectShape, isRequiredField } from "../binding/schema-shape.js";
import type { ParameterTypeConfig } from "../config/schema.js";
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
// whose kind can't be statically cleared, and a table/docstring's "exactly
// one unconsumed required key" rule. Deliberately knows nothing about *why*
// a pattern failed to build (that is binding-check's own issue already) — a
// pattern missing from `patterns` (because it errored there) simply cannot
// match anything here, which is the right behavior: this module must not
// report the same root cause a second time under a different code.
//
// `then-mutates` is a *warning*, not an error (m2pre-observed task spec,
// decision 5, superseding this module's earlier classification): a
// declared-mutating step bound in Then position is a tension worth a
// reviewer's eyes, but `mutates` is a declaration nukadoko trusts, not a
// fact the tool re-derives from what ran — nothing at run time settles this
// tension anymore (docs/spec.md "Keyword semantics"). Every other issue
// this module reports stays an error.
//
// m2a-compat-registry task spec, item 6: a compat pattern participates in
// undefined-step and ambiguous-match detection on equal footing with a typed
// one (both live in the one `patterns` array binding-check.ts already built,
// matched through `checkedPatternMatches` below regardless of whether the
// candidate is cucumber-expression- or RegExp-based). Once a pickle step
// resolves to exactly one compat entry, this module's two typed-only checks
// — the mutates/Then tension and the table/docstring key rule — do not
// apply (compat has no declared `mutates` and no args schema to check a
// table/docstring against); Then-position compat instead gets its own soft
// warning, since compat has no declaration to trust here at all — a static
// coverage gap, not a run-time finding (docs/spec.md "Compat steps",
// "Keyword semantics").

interface MatchResult {
  readonly stepNames: readonly string[];
  /** The (first) pattern of the single step that matched, when exactly one
   * step matched — used for the table/docstring key check below, which
   * needs to know which capture keys that specific match consumed. */
  readonly matched: CheckedPattern | undefined;
}

/**
 * Whether `candidate` matches `text`, regardless of which matcher kind it
 * is. A fresh `RegExp` is constructed per call for the `"regexp"` case: a
 * compat pattern with a `/g`/`/y` flag would otherwise carry `lastIndex`
 * state across the many pickle-step texts this module tests it against in
 * its loops, which `.test()` on the stored instance would silently corrupt.
 */
function checkedPatternMatches(candidate: CheckedPattern, text: string): boolean {
  if (candidate.matcherKind === "regexp") {
    return new RegExp(candidate.regexp.source, candidate.regexp.flags).test(text);
  }
  return candidate.expression.match(text) !== null;
}

// Not a general "reserved character" linter (docs/spec.md is explicit that
// one is impossible: optional/alternation syntax is legitimate and intent
// can't be told apart statically). Scoped to the one case where intent is
// no longer ambiguous — this pickle step text matched *nothing*, so trying
// "what if this candidate's bare ( ) / had been escaped" costs nothing and,
// when it turns a non-match into a match, names both the cause (unescaped
// reserved syntax) and the fix in the same breath. Returns undefined (no
// hint) rather than guessing when the escaped variant still doesn't match.
// Compat RegExp candidates are skipped entirely — there is no cucumber-
// expression source text to escape for one.
function findEscapeHint(
  text: string,
  patterns: readonly CheckedPattern[],
  customTypes: readonly ParameterTypeConfig[],
): CheckedPattern | undefined {
  // A config.parameterTypes collision would already have been reported once
  // by src/check/binding-check.ts as `parameter-type-invalid` — this second
  // attempt to build a registry exists only for the escape-hint's own
  // rebuild-with-escaping check, so a failure here is silently "no hint"
  // rather than a second report of the same root cause.
  let registry: ReturnType<typeof createParameterTypeRegistry>;
  try {
    registry = createParameterTypeRegistry(customTypes);
  } catch {
    return undefined;
  }
  for (const candidate of patterns) {
    if (candidate.matcherKind === "regexp") {
      continue;
    }
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
    if (checkedPatternMatches(candidate, text)) {
      byStep.set(candidate.stepName, candidate);
    }
  }
  const stepNames = [...byStep.keys()];
  // The `!` is safe: `stepNames` was just built from `byStep`'s own keys, so
  // when its length is exactly 1 that one key is guaranteed to be there.
  const matched = stepNames.length === 1 ? byStep.get(stepNames[0]!) : undefined;
  return { stepNames, matched };
}

export interface FeatureCheckResult {
  readonly errors: readonly CheckIssue[];
  readonly warnings: readonly CheckIssue[];
}

export function checkFeatures(
  features: readonly FeatureFile[],
  vocabulary: Vocabulary,
  patterns: readonly CheckedPattern[],
  customTypes: readonly ParameterTypeConfig[] = [],
): FeatureCheckResult {
  const errors: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];

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
          const escapeHint = findEscapeHint(step.text, patterns, customTypes);
          const hintSuffix = escapeHint
            ? ` — hint: would match step "${escapeHint.stepName}" pattern "${escapeHint.pattern}" if its bare ( ) / were escaped — cucumber-expressions reads bare ( ) as optional text and / as alternation`
            : "";
          errors.push({
            code: "undefined-step",
            message: `No step definition matches "${step.text}"; run \`nuka scaffold <name>\` to add one${hintSuffix}`,
            file: feature.relativePath,
            line,
          });
          continue;
        }

        if (stepNames.length > 1) {
          errors.push({
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

        if (step.type === PickleStepType.OUTCOME) {
          if (entry.kind === "typed" && entry.step.mutates) {
            warnings.push({
              code: "then-mutates",
              message: `Step "${stepName}" is bound in Then position but declares mutates: true — declaration and position are in tension here (docs/spec.md "Keyword semantics")`,
              file: feature.relativePath,
              line,
              step: stepName,
            });
          } else if (entry.kind === "compat") {
            warnings.push({
              code: "then-compat-step",
              message: `Step "${stepName}" is a compat step bound in Then position — compat steps have no mutates declaration to trust here; this is a static coverage gap, not something the tool caught at run time (docs/spec.md "Compat steps", "Keyword semantics")`,
              file: feature.relativePath,
              line,
              step: stepName,
            });
          }
        }

        const attachment = step.argument;
        if (
          entry.kind === "typed" &&
          matched &&
          (attachment?.dataTable !== undefined || attachment?.docString !== undefined)
        ) {
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
              errors.push({
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

  return { errors, warnings };
}
