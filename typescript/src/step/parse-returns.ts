import type { z } from "zod";
import { formatValidationIssues } from "../issues/format-issues.js";
import { declaresReturns, type Step } from "./define-step.js";

// Responsibility: parse what a typed step's `run` gave back against its
// `returns`, and word the failure where zod's own text names neither the
// cause nor the fix. `nuka run`, `nuka do`, and a part reached
// through `call` all parse here, so a step passes or fails the same way on
// each. Does not run the step or write a record.

export type ReturnsParse =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly message: string };

export function parseStepReturns(step: Step, value: unknown): ReturnsParse {
  const parsed = step.returns.safeParse(value);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  return { success: false, message: `returns validation failed: ${explain(step, value, parsed.error.issues)}` };
}

function explain(step: Step, value: unknown, issues: readonly z.core.$ZodIssue[]): string {
  if (!declaresReturns(step)) {
    // The default schema is a strict empty object, so its only way to
    // refuse an object is by naming the keys it would have stripped.
    const dropped = issues.find((issue) => issue.code === "unrecognized_keys" && issue.path.length === 0);
    if (dropped !== undefined && dropped.code === "unrecognized_keys") {
      const one = dropped.keys.length === 1;
      return (
        `this step declares no returns, so ${dropped.keys.join(", ")} would be dropped from the step record; ` +
        `declare returns with ${one ? "that key" : "those keys"}, or stop returning ${one ? "it" : "them"}`
      );
    }
  } else if (value === undefined) {
    // zod's "(root): expected object, received undefined" names neither
    // the cause nor either fix.
    return (
      "this step declares returns, but run returned nothing; return a value that matches returns, " +
      "or delete returns if no later step reads from this one"
    );
  }
  // The harness awaits what run returns, so a Promise can only survive
  // inside the value, where it is a call nobody awaited. That much is
  // certain; a key that is undefined because it was read off an unawaited
  // Promise is not, and gets zod's text alone.
  const unawaited = issues
    .filter((issue) => isThenable(valueAt(value, issue.path)))
    .map((issue) => (issue.path.length > 0 ? issue.path.join(".") : "(root)"));
  const hint =
    unawaited.length === 0
      ? ""
      : `; ${unawaited.join(", ")} ${unawaited.length === 1 ? "holds a Promise" : "hold Promises"}: await the call inside run`;
  return formatValidationIssues(issues) + hint;
}

function valueAt(value: unknown, issuePath: readonly PropertyKey[]): unknown {
  let current = value;
  for (const key of issuePath) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
