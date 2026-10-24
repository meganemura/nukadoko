import type { z } from "zod";
import { asObjectShape } from "../binding/schema-shape.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import { tryFromCandidates, type StepFromMap } from "../step/define-step.js";
import type { CheckIssue } from "./types.js";

// Responsibility: the `schema-field-undescribed` note, aimed at the agent
// rather than the human author: a human reading the step file sees the
// surrounding code, while the agent choosing between two steps sees only what
// `nuka describe` prints. Boundary: checks every object-shaped
// `args`/`returns` field of every typed step; a step whose schema is not a
// `z.object` at all has no fields to check (the same `asObjectShape`
// narrowing src/check/binding-check.ts and src/check/feature-check.ts use).
//
// One issue per step, rather than one per field (which would flood a reader
// in a large schema), listing every missing field across *both* `args` and
// `returns`, each prefixed with its schema: a step's contract is the pair
// together, and a bare field name does not say which side it is on.
//
// zod 4's own `.describe(text)` (node_modules/zod/v4/classic/schemas.js)
// clones whatever schema it is called on and registers `{ description: text
// }` on that specific clone in zod's `globalRegistry`; `.meta()` with no
// arguments reads it back (`core.globalRegistry.get(this)`) for that exact
// object only, not anything it wraps or is wrapped by (confirmed against this
// repo's pinned zod 4.4.3). So *where* the description lives depends on chain
// order: `.describe(d).optional()` puts it on the pre-wrap schema, one
// wrapper down from the field as stored in the shape; `.optional
// ().describe(d)` puts it on the field exactly as stored. `hasDescription`
// below checks every layer while unwrapping, never just the first or the
// last, so neither ordering is missed. The unwrap step is deliberately wider
// than src/binding/schema-shape.ts's: that module only needs optional/default
// to find the shape underneath, while a description can sit under any wrapper.

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

// A field's own `label.key` name plus whether it carries a `.describe()`.
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

export function findUndescribedFields(vocabulary: Vocabulary): CheckIssue[] {
  const issues: CheckIssue[] = [];
  for (const entry of vocabulary.values()) {
    if (entry.kind !== "typed") {
      continue; // Compat has no zod schema at all.
    }
    const missing = [
      ...fieldCoverage(entry.step.args, "args", entry.step.from),
      ...fieldCoverage(entry.step.returns, "returns"),
    ].filter((field) => !field.described);
    if (missing.length === 0) {
      continue;
    }
    issues.push({
      code: "schema-field-undescribed",
      message: `Step "${entry.name}" has schema fields with no .describe(): ${missing.map((field) => field.name).join(", ")}. \`nuka describe\` can name them but not explain them, which is all an agent choosing between steps has to go on.`,
      step: entry.name,
    });
  }
  return issues;
}
