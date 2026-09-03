import { CucumberExpression } from "@cucumber/cucumber-expressions";
import type { PickleStepArgument } from "@cucumber/messages";
import type { z } from "zod";
import { buildExpression } from "../binding/expression.js";
import { type Capture } from "../binding/pattern.js";
import { createParameterTypeRegistry } from "../binding/registry.js";
import { asObjectShape, isRequiredField } from "../binding/schema-shape.js";
import type { ParameterTypeConfig } from "../config/schema.js";
import type { Vocabulary } from "../discover/discover-steps.js";

// Responsibility: the run-time half of the shared seam — build the matching
// CucumberExpression (or, for a compat RegExp pattern, nothing to build at
// all) for every pattern in the vocabulary directly from src/binding/* (not
// src/check/binding-check.ts, which mixes in check-only issue reporting —
// this module runs matches and binds at the same layer check does, without
// mixing in check-only knowledge), match one pickle step's text against
// them, and zip the matched values onto the step's named capture keys plus
// the one table/docstring key they left unconsumed ("final argument" rule,
// enforced here at run time exactly as `nuka check` enforces it statically).
// A pattern that fails to build (bad capture name, unknown parameter type)
// can never match anything at run time either — reporting *why* it failed to
// build is `nuka check`'s job, not this module's; here it is simply skipped,
// so any pickle step text relying on it surfaces as "undefined" instead.
//
// A compat entry now contributes a binding here too, on equal footing with
// a typed one, closing a gap where a pattern that only a compat step
// matched used to come back defined from `nuka check`'s static matching but
// undefined at `nuka run` time, because run-time matching covered typed
// entries only — a compat *string* pattern builds a plain
// `CucumberExpression` with no named-capture requirement (identical
// treatment to src/check/binding-check.ts's own compat handling: the
// migration door's promise is unmodified cucumber-expressions syntax), and a
// compat *RegExp* pattern needs no building at all, matched via `.exec()`
// with its captured group strings as positional values (cucumber-js's own
// semantics). `buildStepBindings`'s registry is built from
// `[...customTypes, ...compatParameterTypes]` — the exact same composition
// order src/check/binding-check.ts already uses — so a pattern using a
// compat-registered `defineParameterType` matches here exactly as `nuka
// check` already treats it as defined, closing that same gap for a
// compat-registered parameter type too.

export type StepBinding =
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
       * to zip a table/docstring key against. */
      readonly captures: readonly Capture[];
      readonly regexp: RegExp;
    };

/**
 * @throws {ParameterTypeCollisionError} `customTypes` (config.parameterTypes)
 *   or `compatParameterTypes` (a compat `defineParameterType` call) names a
 *   type that collides with a built-in type or another entry in the same
 *   composed list (src/binding/registry.ts) — a config/support-authoring
 *   error, not a per-pattern one, so it is not caught here; callers
 *   (src/cli/run.ts) treat it as a setup failure, same as any other
 *   malformed config.
 */
export function buildStepBindings(
  vocabulary: Vocabulary,
  customTypes: readonly ParameterTypeConfig[] = [],
  compatParameterTypes: readonly ParameterTypeConfig[] = [],
): readonly StepBinding[] {
  const registry = createParameterTypeRegistry([...customTypes, ...compatParameterTypes]);
  const bindings: StepBinding[] = [];
  for (const entry of vocabulary.values()) {
    if (entry.kind === "typed") {
      for (const pattern of entry.step.patterns) {
        let built: ReturnType<typeof buildExpression>;
        try {
          built = buildExpression(pattern, registry);
        } catch {
          continue;
        }
        bindings.push({
          matcherKind: "expression",
          stepName: entry.name,
          pattern,
          captures: built.captures,
          expression: built.expression,
        });
      }
      continue;
    }

    // entry.kind === "compat": one pattern per entry, no aliases, no named
    // captures — see this file's own header.
    const pattern = entry.compat.patternSource;
    if (typeof entry.compat.pattern === "string") {
      let expression: CucumberExpression;
      try {
        // No `buildExpression`/`stripCaptureNames` here, on purpose: a
        // compat string pattern is unmodified cucumber-expressions syntax
        // (src/check/binding-check.ts's own compat branch does the same).
        expression = new CucumberExpression(entry.compat.pattern, registry);
      } catch {
        continue;
      }
      bindings.push({ matcherKind: "expression", stepName: entry.name, pattern, captures: [], expression });
    } else {
      bindings.push({
        matcherKind: "regexp",
        stepName: entry.name,
        pattern,
        captures: [],
        regexp: entry.compat.pattern,
      });
    }
  }
  return bindings;
}

export type MatchOutcome =
  | { readonly kind: "undefined" }
  | { readonly kind: "ambiguous"; readonly stepNames: readonly string[] }
  | {
      readonly kind: "matched";
      readonly stepName: string;
      readonly captures: readonly Capture[];
      readonly values: readonly unknown[];
    };

/**
 * Matches `text` against every binding, one candidate per distinct step name
 * — two patterns/aliases of the *same* step both matching is not ambiguous,
 * only two *different* steps (typed or compat alike — a match across kinds
 * is ambiguous, a run-time error with the same semantics check already
 * gives it) matching is (the same rule
 * src/check/feature-check.ts applies statically).
 * Coercion happens here via `Argument.getValue` (the parameter type's
 * transformer, e.g. `{int}` -> number, or a `config.parameterTypes`/compat
 * `defineParameterType` entry's own transformer). Neither `getValue` nor this
 * function ever `await`s the result, so a custom transformer must be
 * synchronous — an async one would hand back an unresolved Promise as the
 * captured value instead of the value it resolves to, which then fails a
 * typed step's own args schema (a compat step has none to fail, but the same
 * unresolved-Promise value would still reach its glue function as-is). If a
 * transformer throws, that throw propagates unchanged, straight out of this
 * function (cucumber-expressions itself does no try/catch around a
 * transformer call, and this module deliberately adds none of its own) —
 * src/run/run-scenario.ts calls this function outside any
 * try/catch of its own too, so today that surfaces as an uncaught exception
 * failing the whole `nuka run` invocation, not a per-step failed step record.
 * `nuka check` never reaches this code path at all: src/check/feature-
 * check.ts's own matching only calls `expression.match()`/`RegExp.test()`,
 * never `Argument.getValue()`, so a transformer is only ever invoked at
 * `nuka run` time.
 *
 * A compat RegExp binding is matched with a *fresh* `RegExp` built from its
 * `source`/`flags`, for the exact reason src/check/feature-check.ts's own
 * `checkedPatternMatches` already documents: a `/g`/`/y`-flagged pattern's
 * `lastIndex` must not carry state
 * across the many pickle-step texts this function is called with, one at a
 * time, over a `nuka run` invocation's lifetime.
 */
export function matchPickleStep(text: string, bindings: readonly StepBinding[]): MatchOutcome {
  const byStep = new Map<string, { binding: StepBinding; values: readonly unknown[] }>();
  for (const binding of bindings) {
    if (byStep.has(binding.stepName)) {
      continue;
    }
    if (binding.matcherKind === "regexp") {
      const match = new RegExp(binding.regexp.source, binding.regexp.flags).exec(text);
      if (match !== null) {
        byStep.set(binding.stepName, { binding, values: match.slice(1) });
      }
      continue;
    }
    const args = binding.expression.match(text);
    if (args !== null) {
      byStep.set(binding.stepName, {
        binding,
        values: args.map((argument) => argument.getValue(null)),
      });
    }
  }
  const stepNames = [...byStep.keys()];
  if (stepNames.length === 0) {
    return { kind: "undefined" };
  }
  if (stepNames.length > 1) {
    return { kind: "ambiguous", stepNames };
  }
  // Safe: exactly one key exists in `byStep` when `stepNames.length === 1`.
  const { binding, values } = byStep.get(stepNames[0]!)!;
  return { kind: "matched", stepName: binding.stepName, captures: binding.captures, values };
}

export type BindArgsResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string; readonly partialValue: Record<string, unknown> };

/**
 * Zips a match's captured values onto their keys, then — when the pickle
 * step carries a table or docstring — binds it to the one required args key
 * the named captures left unconsumed. Zero or several unconsumed required
 * keys, or an args schema that isn't even a `z.object` to ask the question
 * of, is a binding failure: counted as "the
 * step's execution began" (like an args-validation failure), not as "never
 * started" (like undefined/ambiguous), so callers still write a failed
 * step record for it.
 */
export function bindStepArgs(
  stepName: string,
  captures: readonly Capture[],
  values: readonly unknown[],
  attachment: PickleStepArgument | undefined,
  argsSchema: z.ZodTypeAny,
  /** The keys the step declares `from` for. A key `from` fills is spoken
   * for before a table/docstring is placed, the same way a captured key
   * is, so a step can take one key from an earlier step and the other from
   * the attachment on the same line. Whether the declared upstream ran is
   * a separate question (the from-order guard), not this function's. */
  fromKeys: ReadonlySet<string> = new Set(),
): BindArgsResult {
  const value: Record<string, unknown> = {};
  captures.forEach((capture, index) => {
    value[capture.key] = values[index];
  });

  const hasAttachment = attachment?.dataTable !== undefined || attachment?.docString !== undefined;
  if (!hasAttachment) {
    return { ok: true, value };
  }

  const shape = asObjectShape(argsSchema);
  if (!shape) {
    return {
      ok: false,
      message: `Step "${stepName}" has a table/docstring attached but its args schema is not a z.object`,
      partialValue: value,
    };
  }

  const consumedKeys = new Set([...captures.map((c) => c.key), ...fromKeys]);
  const unconsumedRequired = Object.entries(shape)
    .filter(([key, fieldSchema]) => !consumedKeys.has(key) && isRequiredField(fieldSchema))
    .map(([key]) => key);
  if (unconsumedRequired.length !== 1) {
    const detail =
      unconsumedRequired.length === 0
        ? "every args key is already consumed by named captures or declared from"
        : `${unconsumedRequired.length} args keys are left unconsumed (${unconsumedRequired.join(", ")}); exactly one is required`;
    return {
      ok: false,
      message: `Step "${stepName}" has a table/docstring attached but ${detail}`,
      partialValue: value,
    };
  }

  const key = unconsumedRequired[0]!;
  if (attachment?.dataTable !== undefined) {
    value[key] = attachment.dataTable.rows.map((row) => row.cells.map((cell) => cell.value));
  } else if (attachment?.docString !== undefined) {
    value[key] = attachment.docString.content;
  }
  return { ok: true, value };
}
