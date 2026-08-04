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
//
// `analyzeFieldDescriptions` (m8c-tend-summary) is now the one export doing
// the walk: it returns this finding's issues *and* the total/described field
// counts src/tend/summary.ts needs for the "how much of what a typed step
// could declare is actually declared" summary line — same `hasDescription`
// call per field either way, so the summary's number and this finding's
// "which fields are missing" can never quietly disagree.

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

// A field's own `label.key` name plus whether it carries a `.describe()` —
// one entry per schema field, so both this finding's "which ones are
// missing" and m8c-tend-summary's "how many total, how many described"
// summary count come from the exact same per-field walk (that task's spec:
// "二度数えないこと"), never a second traversal re-deciding `hasDescription`
// for the summary.
interface FieldCoverageEntry {
  readonly name: string;
  readonly described: boolean;
}

function fieldCoverage(schema: z.ZodTypeAny, label: "args" | "returns"): FieldCoverageEntry[] {
  const shape = asObjectShape(schema);
  if (shape === undefined) {
    return [];
  }
  return Object.entries(shape).map(([key, fieldSchema]) => ({
    name: `${label}.${key}`,
    described: hasDescription(fieldSchema),
  }));
}

/** `findMissingFieldDescriptions`'s issues, plus the field totals m8c-tend-
 * summary's "how much of what a typed step could declare is actually
 * declared" summary line needs — both `args` and `returns` fields of every
 * typed step, counted once here rather than a second time in
 * src/tend/summary.ts. */
export interface FieldDescriptionAnalysis {
  readonly issues: TendIssue[];
  readonly totalFields: number;
  readonly describedFields: number;
}

export function analyzeFieldDescriptions(vocabulary: Vocabulary): FieldDescriptionAnalysis {
  const issues: TendIssue[] = [];
  let totalFields = 0;
  let describedFields = 0;

  for (const entry of vocabulary.values()) {
    if (entry.kind !== "typed") {
      continue; // Compat has no zod schema at all.
    }
    const fields = [...fieldCoverage(entry.step.args, "args"), ...fieldCoverage(entry.step.returns, "returns")];
    const missing = fields.filter((field) => !field.described);
    totalFields += fields.length;
    describedFields += fields.length - missing.length;

    if (missing.length === 0) {
      continue;
    }
    issues.push({
      code: "schema-field-undescribed",
      message: `Step "${entry.name}" has schema fields with no .describe(): ${missing.map((field) => field.name).join(", ")} — \`nuka describe\` can name them but not explain them, which is all an agent choosing between steps has to go on.`,
      step: entry.name,
    });
  }

  return { issues, totalFields, describedFields };
}
