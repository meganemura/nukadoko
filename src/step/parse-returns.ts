import type { z } from "zod";
import { formatValidationIssues } from "../issues/format-issues.js";
import { declaresReturns, type Step } from "./define-step.js";

// Responsibility: parse what a typed step's `run` gave back against its
// `returns`, and word the failure where zod's own text names neither the
// cause nor the fix. `nuka run`, `nuka do`, explore, and a part reached
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
  return { success: false, message: `returns validation failed: ${explain(step, parsed.error.issues)}` };
}

function explain(step: Step, issues: readonly z.core.$ZodIssue[]): string {
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
  }
  return formatValidationIssues(issues);
}
