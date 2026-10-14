import type { z } from "zod";
import { asObjectShape } from "../binding/schema-shape.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import { tryFromCandidates, type StepFromMap } from "../step/define-step.js";
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
// One issue per step, rather than one per field (which would flood a
// reader in a large schema), listing every missing
// field across *both* `args` and `returns`, each prefixed with which schema
// it's in — a step's contract is the pair together, and an agent reading
// `nuka tend`'s output needs to know which side a bare field name refers to.
//
// zod 4's own `.describe(text)` (node_modules/zod/v4/classic/schemas.js)
// clones whatever schema it's called on and registers `{ description: text
// }` on that specific clone in zod's `globalRegistry`; `.meta()` with no
// arguments reads it back (`core.globalRegistry.get(this)`) — for that
// exact object only, not anything it wraps or is wrapped by (empirically
// confirmed against this repo's own pinned zod 4.4.3). That means *where*
// the description lives depends on chain
// order: `.describe(d).optional()` puts it on the pre-wrap schema, one
// wrapper down from the field as stored in the shape; `.optional
// ().describe(d)` puts it on the field exactly as stored, no unwrapping
// needed. `hasDescription` below checks every layer while unwrapping,
// never just the first or the last, so neither ordering is missed.
// The unwrap step is deliberately wider than src/binding/schema-shape.ts's:
// that module only needs optional/default to find the shape underneath,
// while a description can sit under any wrapper.
//
// `analyzeFieldDescriptions` is now the one export doing
// the walk: it returns this finding's issues *and* the total/described field
// counts src/tend/summary.ts needs for the "how much of what a typed step
// could declare is actually declared" summary line — same `hasDescription`
// call per field either way, so the summary's number and this finding's
// "which fields are missing" can never quietly disagree.

// Every wrapper that keeps the described schema one level down: optional,
// default, nullable, nullish, readonly, catch and prefault carry it in
// `innerType`, a pipe (`.transform()`, `.pipe()`) in `in`.
function innerSchema(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = schema._zod.def as { innerType?: z.ZodTypeAny; in?: z.ZodTypeAny };
  return def.innerType ?? def.in;
}

function hasDescription(fieldSchema: z.ZodTypeAny): boolean {
  let current: z.ZodTypeAny | undefined = fieldSchema;
  while (current !== undefined) {
    if (current.meta()?.description !== undefined) {
      return true;
    }
    current = innerSchema(current);
  }
  return false;
}

// A field's own `label.key` name plus whether it carries a `.describe()` —
// one entry per schema field, so both this finding's "which ones are
// missing" and the summary's "how many total, how many described"
// summary count come from the exact same per-field walk, never a second
// traversal re-deciding `hasDescription` for the summary.
interface FieldCoverageEntry {
  readonly name: string;
  readonly described: boolean;
}

// An args key `from` fills is a value the agent never writes: `nuka
// describe` names its producer, and the producer's returns field explains
// it. Asking each consumer to repeat that sentence would duplicate it, and
// the copies drift. So the key counts as described when every candidate
// producer's field does; an undescribed producer field still leaves it
// reported, since then nothing explains it.
function describedByProducers(from: StepFromMap, key: string): boolean {
  const entry = from[key];
  if (entry === undefined) {
    return false;
  }
  const candidates = tryFromCandidates(entry);
  if (candidates === null) {
    return false;
  }
  return candidates.every(([producer, producerKey]) => {
    const producerField = asObjectShape(producer.returns)?.[producerKey];
    return producerField !== undefined && hasDescription(producerField);
  });
}

function fieldCoverage(schema: z.ZodTypeAny, label: "args" | "returns", from: StepFromMap = {}): FieldCoverageEntry[] {
  const shape = asObjectShape(schema);
  if (shape === undefined) {
    return [];
  }
  return Object.entries(shape).map(([key, fieldSchema]) => ({
    name: `${label}.${key}`,
    described: hasDescription(fieldSchema) || describedByProducers(from, key),
  }));
}

/** `findMissingFieldDescriptions`'s issues, plus the field totals the
 * "how much of what a typed step could declare is actually
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
    const fields = [
      ...fieldCoverage(entry.step.args, "args", entry.step.from),
      ...fieldCoverage(entry.step.returns, "returns"),
    ];
    const missing = fields.filter((field) => !field.described);
    totalFields += fields.length;
    describedFields += fields.length - missing.length;

    if (missing.length === 0) {
      continue;
    }
    issues.push({
      code: "schema-field-undescribed",
      message: `Step "${entry.name}" has schema fields with no .describe(): ${missing.map((field) => field.name).join(", ")}. \`nuka describe\` can name them but not explain them, which is all an agent choosing between steps has to go on.`,
      step: entry.name,
    });
  }

  return { issues, totalFields, describedFields };
}
