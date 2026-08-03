import { CucumberExpression, type ParameterTypeRegistry } from "@cucumber/cucumber-expressions";
import { type Capture, stripCaptureNames } from "./pattern.js";

// Responsibility: turn one committed `pattern`/`patterns` entry into the
// thing that actually matches Gherkin text — the one seam `nuka check`
// (undefined-step/ambiguous-match detection) and `nuka run` (matching a
// pickle step to execute it) share, so a change to matching behavior has
// exactly one place to make it (this task's spec, decision 1: run matches
// and binds at the same layer check does, without mixing in check-only
// knowledge). Building throws
// straight through, on purpose: a capture-naming problem (pattern.ts) or an
// unknown parameter type name (cucumber-expressions' own
// UndefinedParameterTypeError) both propagate as-is — turning either into a
// formatted, located check issue is src/check/binding-check.ts's job, not
// this module's.

export interface BoundExpression {
  readonly pattern: string;
  readonly captures: readonly Capture[];
  readonly expression: CucumberExpression;
}

export function buildExpression(pattern: string, registry: ParameterTypeRegistry): BoundExpression {
  const { strippedPattern, captures } = stripCaptureNames(pattern);
  const expression = new CucumberExpression(strippedPattern, registry);
  return { pattern, captures, expression };
}
