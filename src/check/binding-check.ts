import { CucumberExpression } from "@cucumber/cucumber-expressions";
import { UndefinedParameterTypeError } from "@cucumber/cucumber-expressions/dist/Errors.js";
import { type Capture, stripCaptureNames } from "../binding/pattern.js";
import { ParameterTypeCollisionError } from "../binding/parameter-type-errors.js";
import { createParameterTypeRegistry } from "../binding/registry.js";
import { InvalidCaptureKeyError, UnnamedCaptureError, UnterminatedCaptureError } from "../binding/errors.js";
import { asObjectShape, classifyPrimitive } from "../binding/schema-shape.js";
import type { ParameterTypeConfig } from "../config/schema.js";
import type { CompatParameterTypeEntry, Vocabulary } from "../discover/discover-steps.js";
import type { CheckIssue } from "./types.js";

// Responsibility: this task's spec decisions 1+2 applied to the whole
// vocabulary — for every pattern-bearing typed step, parse+strip each of its
// patterns (src/binding/pattern.ts), build the matching CucumberExpression
// (src/binding/expression.ts's underlying pieces), and check the result
// against the step's `args` schema (src/binding/schema-shape.ts). Also the
// two vocabulary-check items that only make sense read across the whole
// vocabulary at once: alias patterns binding different key sets, and two
// patterns normalizing to the same text. Returns both the check issues
// *and* every pattern that built successfully — src/check/feature-check.ts
// reuses the latter to match pickle steps, so this is the one place the
// vocabulary's patterns are parsed for the whole `nuka check` run.
//
// m2a-compat-registry task spec, item 6 extends all of the above to compat
// vocabulary entries: a compat pattern participates in undefined-step and
// ambiguous-match detection exactly like a typed one (both live in the one
// `patterns` array feature-check.ts consumes), and in duplicate-pattern
// detection *across* kind — a compat string pattern is built as a plain
// cucumber-expression with **no named-capture requirement** (the migration
// door's promise: compat prose is unmodified cucumber-expressions syntax,
// docs/spec.md "Compat steps"), so it is never run through
// `stripCaptureNames`. A compat RegExp pattern needs no "building" at all —
// it is matched as-is — and is compared for duplicates only against other
// RegExp patterns (a distinct text namespace from cucumber-expression
// source text). Neither compat variant is checked against an args schema
// (compat has none) or folded into the alias-key-mismatch check (compat has
// no aliases — one registration is one pattern is one vocabulary entry).
// This module also merges every compat-origin `defineParameterType` call
// into the *same* registry config-origin entries use, so a name collision
// between the two sources raises the exact same `parameter-type-invalid`
// issue a config/config collision already does. Listing each compat-origin
// registration as its own finding used to happen here too, as a warning;
// it moved to src/tend/parameter-type-support-origin.ts (m8d-move-to-tend
// task spec) — it fires for as long as a suite has any compat left, which
// is a normal in-progress state rather than a reason to stop a run, so it
// no longer belongs on `nuka check`'s own report.

export type CheckedPattern =
  | {
      readonly matcherKind: "expression";
      readonly stepName: string;
      readonly pattern: string;
      readonly captures: readonly Capture[];
      readonly expression: CucumberExpression;
    }
  | {
      readonly matcherKind: "regexp";
      readonly stepName: string;
      readonly pattern: string;
      /** Always `[]`: a compat RegExp pattern has no named-capture concept
       * to bind a table/docstring key against (typed-only, docs/spec.md
       * "Typed steps": "Gherkin tables get types for the first time"). */
      readonly captures: readonly Capture[];
      readonly regexp: RegExp;
    };

export interface BindingCheckResult {
  readonly issues: readonly CheckIssue[];
  readonly warnings: readonly CheckIssue[];
  readonly patterns: readonly CheckedPattern[];
}

interface StripResult {
  readonly pattern: string;
  readonly strippedPattern: string;
  readonly captures: readonly Capture[];
}

function captureErrorToIssue(error: unknown, stepName: string, pattern: string): CheckIssue {
  const context = `Step "${stepName}" pattern "${pattern}"`;
  if (error instanceof UnnamedCaptureError) {
    return { code: "unnamed-capture", message: `${context}: ${error.message}`, step: stepName };
  }
  if (error instanceof InvalidCaptureKeyError) {
    return { code: "invalid-capture-key", message: `${context}: ${error.message}`, step: stepName };
  }
  if (error instanceof UnterminatedCaptureError) {
    return { code: "unterminated-capture", message: `${context}: ${error.message}`, step: stepName };
  }
  return {
    code: "pattern-error",
    message: `${context}: ${error instanceof Error ? error.message : String(error)}`,
    step: stepName,
  };
}

function expressionErrorToIssue(error: unknown, stepName: string, pattern: string): CheckIssue {
  const context = `Step "${stepName}" pattern "${pattern}"`;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UndefinedParameterTypeError) {
    return {
      code: "unknown-parameter-type",
      message: `${context}: ${message}`,
      step: stepName,
    };
  }
  return { code: "pattern-syntax-error", message: `${context}: ${message}`, step: stepName };
}

export function checkBindings(
  vocabulary: Vocabulary,
  customTypes: readonly ParameterTypeConfig[] = [],
  compatParameterTypes: readonly CompatParameterTypeEntry[] = [],
): BindingCheckResult {
  const warnings: CheckIssue[] = [];

  // A name collision in config.parameterTypes (against a built-in type,
  // another config entry, or now a compat-origin entry — this reuses the
  // existing collision error) is a config-authoring error, not something any individual
  // pattern did wrong (this task's spec, decision 3) — reported once, here,
  // as its own issue rather than once per pattern that would otherwise have
  // used the registry. No pattern can be checked at all without a working
  // registry, so `patterns` is empty in this case, same as any other early
  // return below.
  let registry: ReturnType<typeof createParameterTypeRegistry>;
  try {
    registry = createParameterTypeRegistry([...customTypes, ...compatParameterTypes]);
  } catch (error) {
    if (error instanceof ParameterTypeCollisionError) {
      return {
        issues: [{ code: "parameter-type-invalid", message: error.message }],
        warnings,
        patterns: [],
      };
    }
    throw error;
  }

  const issues: CheckIssue[] = [];
  const patterns: CheckedPattern[] = [];
  // strippedPattern -> every (stepName, pattern) that normalizes to it,
  // across the *entire* vocabulary and *across kind* (this task's spec,
  // item 6: duplicate detection spans kind) — a typed step's stripped
  // pattern and a compat string pattern share this one text namespace
  // because both are, in the end, plain cucumber-expression source; a
  // compat RegExp pattern has its own separate namespace below (regexpText
  // Owners), since a regex source and a cucumber-expression's are not
  // comparable text.
  const strippedTextOwners = new Map<string, { stepName: string; pattern: string }[]>();
  const regexpTextOwners = new Map<string, { stepName: string; pattern: string }[]>();

  const entries = [...vocabulary.values()].sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.kind === "compat") {
      continue;
    }
    const stepName = entry.name;
    if (entry.step.patterns.length === 0) {
      continue;
    }

    // Decision 2: a pattern-bearing step's args must be a z.object. When it
    // isn't, there is no shape to check keys/types against, so this step's
    // patterns still get parsed below (for duplicate-text detection and to
    // populate `patterns` for feature-check), just never key/type-checked.
    const shape = asObjectShape(entry.step.args);
    if (!shape) {
      issues.push({
        code: "args-not-object",
        message: `Step "${stepName}" has a pattern but its args schema is not a z.object`,
        step: stepName,
      });
    }

    const stripResults: StripResult[] = [];

    for (const pattern of entry.step.patterns) {
      let stripped: ReturnType<typeof stripCaptureNames>;
      try {
        stripped = stripCaptureNames(pattern);
      } catch (error) {
        issues.push(captureErrorToIssue(error, stepName, pattern));
        continue;
      }
      stripResults.push({
        pattern,
        strippedPattern: stripped.strippedPattern,
        captures: stripped.captures,
      });

      const owners = strippedTextOwners.get(stripped.strippedPattern) ?? [];
      owners.push({ stepName, pattern });
      strippedTextOwners.set(stripped.strippedPattern, owners);

      let expression: CucumberExpression;
      try {
        expression = new CucumberExpression(stripped.strippedPattern, registry);
      } catch (error) {
        issues.push(expressionErrorToIssue(error, stepName, pattern));
        continue;
      }
      patterns.push({
        matcherKind: "expression",
        stepName,
        pattern,
        captures: stripped.captures,
        expression,
      });

      if (!shape) {
        continue;
      }
      for (const capture of stripped.captures) {
        const fieldSchema = shape[capture.key];
        if (!fieldSchema) {
          issues.push({
            code: "unknown-capture-key",
            message: `Step "${stepName}" pattern "${pattern}" binds key "${capture.key}", which is not a key of its args schema`,
            step: stepName,
          });
          continue;
        }
        const primitive = classifyPrimitive(fieldSchema);
        if ((capture.type === "int" || capture.type === "float") && primitive === "string") {
          issues.push({
            code: "capture-type-mismatch",
            message: `Step "${stepName}" pattern "${pattern}" binds key "${capture.key}" as {${capture.type}} (a number), but args declares "${capture.key}" as a string`,
            step: stepName,
          });
        } else if ((capture.type === "string" || capture.type === "word") && primitive === "number") {
          issues.push({
            code: "capture-type-mismatch",
            message: `Step "${stepName}" pattern "${pattern}" binds key "${capture.key}" as {${capture.type}} (a string), but args declares "${capture.key}" as a number`,
            step: stepName,
          });
        }
      }
    }

    if (stripResults.length > 1) {
      const signatures = new Set(
        stripResults.map((r) => [...new Set(r.captures.map((c) => c.key))].sort().join(",")),
      );
      if (signatures.size > 1) {
        issues.push({
          code: "alias-key-mismatch",
          message: `Step "${stepName}" has patterns that bind different key sets: ${stripResults
            .map((r) => `"${r.pattern}" -> {${[...new Set(r.captures.map((c) => c.key))].join(", ")}}`)
            .join("; ")}`,
          step: stepName,
        });
      }
    }
  }

  // Compat entries: one pattern per entry, no aliases, no args schema — just
  // build the matcher and register it for duplicate/undefined/ambiguous
  // detection (this task's spec, item 6, first bullet).
  for (const entry of entries) {
    if (entry.kind !== "compat") {
      continue;
    }
    const stepName = entry.name;
    const pattern = entry.compat.patternSource;

    if (typeof entry.compat.pattern === "string") {
      // No stripCaptureNames here, on purpose — compat prose is unmodified
      // cucumber-expressions syntax (`{string}`, `{int}`, a custom type
      // name), never nukadoko's `{key:type}` naming convention (this task's
      // spec, item 6: a compat string pattern is not required to use
      // named-capture syntax).
      const owners = strippedTextOwners.get(entry.compat.pattern) ?? [];
      owners.push({ stepName, pattern });
      strippedTextOwners.set(entry.compat.pattern, owners);

      let expression: CucumberExpression;
      try {
        expression = new CucumberExpression(entry.compat.pattern, registry);
      } catch (error) {
        issues.push(expressionErrorToIssue(error, stepName, pattern));
        continue;
      }
      patterns.push({ matcherKind: "expression", stepName, pattern, captures: [], expression });
    } else {
      const regexpText = entry.compat.pattern.toString();
      const owners = regexpTextOwners.get(regexpText) ?? [];
      owners.push({ stepName, pattern });
      regexpTextOwners.set(regexpText, owners);

      patterns.push({
        matcherKind: "regexp",
        stepName,
        pattern,
        captures: [],
        regexp: entry.compat.pattern,
      });
    }
  }

  for (const [strippedPattern, owners] of strippedTextOwners) {
    if (owners.length > 1) {
      issues.push({
        code: "duplicate-pattern",
        message: `Multiple patterns normalize to the same text "${strippedPattern}": ${owners
          .map((o) => `${o.stepName} ("${o.pattern}")`)
          .join(", ")}`,
      });
    }
  }
  for (const [regexpText, owners] of regexpTextOwners) {
    if (owners.length > 1) {
      issues.push({
        code: "duplicate-pattern",
        message: `Multiple compat RegExp patterns are the same expression ${regexpText}: ${owners
          .map((o) => `${o.stepName}`)
          .join(", ")}`,
      });
    }
  }

  return { issues, warnings, patterns };
}
