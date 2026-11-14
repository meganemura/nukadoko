import type { PickleStepArgument } from "@cucumber/messages";
import type { z } from "zod";

// Responsibility: whether the table or docstring on a pickle step can never
// satisfy the args key it fills. src/run/match-step.ts's `bindStepArgs`
// hands a table over as `string[][]` and a docstring as a `string` (its
// media type is dropped), so a plain string key given a table, or a plain
// array/number/boolean/object key given a docstring, fails args validation
// with certainty. Only the schema types that can end one way are reported:
// an array key given a table (element type unknown), a coercing schema, a
// pipe, a transform, a union and every other wrapper stay silent. The key
// is required, so zod's optional/default wrappers are never on it.

const REJECTS_STRING = new Set(["array", "number", "boolean", "object"]);

export function attachmentTypeMismatch(
  stepName: string,
  key: string,
  attachment: PickleStepArgument | undefined,
  fieldSchema: z.ZodTypeAny,
): string | undefined {
  if ((fieldSchema.def as { coerce?: unknown }).coerce === true) {
    return undefined;
  }
  if (attachment?.dataTable !== undefined && fieldSchema.type === "string") {
    return (
      `Step "${stepName}" has a table attached, which fills args key "${key}" as an array of rows ` +
      `(string[][]), but "${key}" is a string. This line would fail args validation with certainty`
    );
  }
  if (attachment?.docString !== undefined && REJECTS_STRING.has(fieldSchema.type)) {
    return (
      `Step "${stepName}" has a docstring attached, which fills args key "${key}" as a string, ` +
      `but "${key}" is a ${fieldSchema.type}. This line would fail args validation with certainty`
    );
  }
  return undefined;
}
