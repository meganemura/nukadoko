import type { Argument, CucumberExpression } from "@cucumber/cucumber-expressions";
import type { PickleStepArgument } from "@cucumber/messages";
import type { z } from "zod";
import { buildExpression } from "../binding/expression.js";
import { type Capture } from "../binding/pattern.js";
import { createParameterTypeRegistry } from "../binding/registry.js";
import { asObjectShape, isRequiredField } from "../binding/schema-shape.js";
import type { ParameterTypeConfig } from "../config/schema.js";
import type { Vocabulary } from "../discover/discover-steps.js";

// Responsibility: the run-time half of capture-binding-design.md's shared
// seam — build the matching CucumberExpression for every pattern in the
// vocabulary directly from src/binding/* (not src/check/binding-check.ts,
// which mixes in check-only issue reporting; this task's spec, decision 1:
// "run が同じ層でマッチ + 束縛を行う前提で、check 専用の知識を混ぜない"), match
// one pickle step's text against them, and zip the matched Argument values
// onto the step's named capture keys plus the one table/docstring key they
// left unconsumed (capture-binding-design.md's "final argument" rule,
// enforced here at run time exactly as `nuka check` enforces it statically).
// A pattern that fails to build (bad capture name, unknown parameter type)
// can never match anything at run time either — reporting *why* it failed to
// build is `nuka check`'s job, not this module's; here it is simply skipped,
// so any pickle step text relying on it surfaces as "undefined" instead.

export interface StepBinding {
  readonly stepName: string;
  readonly pattern: string;
  readonly captures: readonly Capture[];
  readonly expression: CucumberExpression;
}

/**
 * @throws {ParameterTypeCollisionError} `customTypes` (config.parameterTypes)
 *   names a type that collides with a built-in type or another entry in the
 *   same list (src/binding/registry.ts) — a config-authoring error, not a
 *   per-pattern one, so it is not caught here; callers (src/cli/run.ts) treat
 *   it as a setup failure, same as any other malformed config.
 */
export function buildStepBindings(
  vocabulary: Vocabulary,
  customTypes: readonly ParameterTypeConfig[] = [],
): readonly StepBinding[] {
  const registry = createParameterTypeRegistry(customTypes);
  const bindings: StepBinding[] = [];
  for (const entry of vocabulary.values()) {
    // Temporary asymmetry (m2a-compat-registry task spec, item 7): `nuka
    // run`'s matching stays typed-only in this slice. Compat step execution
    // — World lifecycle, receipt shape, mixed-kind matching — is M2's slice
    // B; until it lands, a pickle line that only a compat pattern matches is
    // still "undefined" here even though `nuka check` (src/check/binding-
    // check.ts) already treats it as defined, since check considers compat
    // patterns too. This gap closes in slice B, not here.
    if (entry.kind !== "typed") {
      continue;
    }
    for (const pattern of entry.step.patterns) {
      let built: ReturnType<typeof buildExpression>;
      try {
        built = buildExpression(pattern, registry);
      } catch {
        continue;
      }
      bindings.push({
        stepName: entry.name,
        pattern,
        captures: built.captures,
        expression: built.expression,
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
 * only two *different* steps matching is (the same rule src/check/
 * feature-check.ts applies statically). Coercion happens here via
 * `Argument.getValue` (the parameter type's transformer, e.g. `{int}` ->
 * number, or a `config.parameterTypes` entry's own transformer). Neither
 * `getValue` nor this function ever `await`s the result, so a custom
 * transformer must be synchronous — an async one would hand back an
 * unresolved Promise as the captured value instead of the value it resolves
 * to, which then fails the step's own args schema. If a transformer throws,
 * that throw propagates unchanged, straight out of this function (this
 * task's spec, decision 5: cucumber-expressions itself does no try/catch
 * around a transformer call, and this module deliberately adds none of its
 * own) — src/run/run-scenario.ts calls this function outside any try/catch
 * of its own too, so today that surfaces as an uncaught exception failing
 * the whole `nuka run` invocation, not a per-step failed receipt. `nuka
 * check` never reaches this code path at all: src/check/feature-check.ts's
 * own matching only calls `expression.match()`, never `Argument.getValue()`,
 * so a transformer is only ever invoked at `nuka run` time.
 */
export function matchPickleStep(text: string, bindings: readonly StepBinding[]): MatchOutcome {
  const byStep = new Map<string, { binding: StepBinding; args: readonly Argument[] }>();
  for (const binding of bindings) {
    if (byStep.has(binding.stepName)) {
      continue;
    }
    const args = binding.expression.match(text);
    if (args !== null) {
      byStep.set(binding.stepName, { binding, args });
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
  const { binding, args } = byStep.get(stepNames[0]!)!;
  const values = args.map((argument) => argument.getValue(null));
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
 * of, is a binding failure — this task's spec, decision 4: counted as "the
 * step's execution began" (like an args-validation failure), not as "never
 * started" (like undefined/ambiguous), so callers still write a failed
 * receipt for it.
 */
export function bindStepArgs(
  stepName: string,
  captures: readonly Capture[],
  values: readonly unknown[],
  attachment: PickleStepArgument | undefined,
  argsSchema: z.ZodTypeAny,
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

  const consumedKeys = new Set(captures.map((c) => c.key));
  const unconsumedRequired = Object.entries(shape)
    .filter(([key, fieldSchema]) => !consumedKeys.has(key) && isRequiredField(fieldSchema))
    .map(([key]) => key);
  if (unconsumedRequired.length !== 1) {
    const detail =
      unconsumedRequired.length === 0
        ? "every args key is already consumed by named captures"
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
