import type { z } from "zod";
import { asObjectShape } from "../binding/schema-shape.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import type { TendIssue } from "./types.js";

// Responsibility: docs/spec.md "Tending"'s "A schema field with no
// `.describe()`" finding — aimed at the agent, not the human author
// (docs/spec.md: "the agent choosing between two steps cannot" see the
// surrounding code the way a human reading the step file can). Checks every
// object-shaped `args`/`returns` field of every typed step; a step whose
// schema isn't a `z.object` at all has no fields to check (same
// `asObjectShape` narrowing src/check/binding-check.ts and
// src/check/feature-check.ts already use — reused, not re-derived).
//
// One issue per step (this task's spec: "step ごとに1件にまとめ… フィール
// ド1つにつき1件だと大きなスキーマで洪水になる"), listing every missing
// field across *both* `args` and `returns`, each prefixed with which schema
// it's in — a step's contract is the pair together, and an agent reading
// `nuka tend`'s output needs to know which side a bare field name refers to.
//
// zod 4's own `.describe(text)` (node_modules/zod/v4/classic/schemas.js)
// clones whatever schema it's called on and registers `{ description: text
// }` on that specific clone in zod's `globalRegistry`; `.meta()` with no
// arguments reads it back (`core.globalRegistry.get(this)`) — for that
// exact object only, not anything it wraps or is wrapped by (empirically
// confirmed against this repo's own pinned zod 4.4.3 — see this task's own
// report). That means *where* the description lives depends on chain
// order: `.describe(d).optional()` puts it on the pre-wrap schema, one
// `.unwrap()` down from the field as stored in the shape; `.optional
// ().describe(d)` puts it on the field exactly as stored, no unwrapping
// needed. `hasDescription` below checks every layer while unwrapping,
// never just the first or the last, so neither ordering is missed.
// `isUnwrappable`/`.unwrap()` themselves mirror src/binding/schema-shape.ts's
// own private (unexported) unwrap step rather than importing it: that
// module isn't in this task's file ownership, and the check is one line
// with no behavior to keep in sync — duplicating it here is cheaper and
// safer than widening that module's exports for one caller.

type Unwrappable = z.ZodTypeAny & { unwrap(): z.ZodTypeAny };

function isUnwrappable(schema: z.ZodTypeAny): schema is Unwrappable {
  return schema.type === "optional" || schema.type === "default";
}

function hasDescription(fieldSchema: z.ZodTypeAny): boolean {
  let current = fieldSchema;
  while (true) {
    if (current.meta()?.description !== undefined) {
      return true;
    }
    if (!isUnwrappable(current)) {
      return false;
    }
    current = current.unwrap();
  }
}

function undescribedFields(schema: z.ZodTypeAny, label: "args" | "returns"): string[] {
  const shape = asObjectShape(schema);
  if (shape === undefined) {
    return [];
  }
  return Object.entries(shape)
    .filter(([, fieldSchema]) => !hasDescription(fieldSchema))
    .map(([key]) => `${label}.${key}`);
}

export function findMissingFieldDescriptions(vocabulary: Vocabulary): TendIssue[] {
  const issues: TendIssue[] = [];

  for (const entry of vocabulary.values()) {
    if (entry.kind !== "typed") {
      continue; // Compat has no zod schema at all.
    }
    const missing = [
      ...undescribedFields(entry.step.args, "args"),
      ...undescribedFields(entry.step.returns, "returns"),
    ];
    if (missing.length === 0) {
      continue;
    }
    issues.push({
      code: "schema-field-undescribed",
      message: `Step "${entry.name}" has schema fields with no .describe(): ${missing.join(", ")} — \`nuka describe\` can name them but not explain them, which is all an agent choosing between steps has to go on.`,
      step: entry.name,
    });
  }

  return issues;
}
