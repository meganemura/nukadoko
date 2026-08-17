import { asObjectShape, isRequiredField } from "../binding/schema-shape.js";
import type { StepRecord } from "../record/types.js";
import { fromCandidates, type Step } from "../step/define-step.js";
import type { Attachment } from "./render-line.js";

// Responsibility: docs/spec.md "Harvesting"'s three-way split for one
// step's args keys that a pattern's own named captures don't consume — the
// only part of `nuka harvest` this task's own spec asks for that isn't
// covered by src/binding/* or src/run/match-step.ts already. Structural
// bookkeeping only (which key falls in which bucket), the same kind of
// static, non-matching computation src/check/unfillable-key.ts and
// src/check/from-order.ts already do for the same "exactly one unconsumed
// required key" rule read from the other direction (checking an existing
// pickle rather than generating one), so this module does not reuse either
// — a Pickle to check against does not exist yet when `nuka harvest` calls
// this.
//
// A key only ever moves into `chainKeys` on *measured* evidence: the step
// record's own `used` array naming an execution of one of that key's
// declared `from` candidates, that execution's id sitting among the ids
// this harvest call was given, and — the one extra check beyond what
// `used` states outright — that upstream's own recorded `result` at the
// named key deep-equals this record's own `args[key]`. That last check
// exists for one narrow case `used` alone cannot rule out: a step whose
// `from` names the same upstream for two different keys, where `--args`
// happened to override one of them directly on the original `nuka do` call.
// `used` cites that upstream regardless (it still filled the *other* key),
// so name-matching alone would blank both; the value check catches the one
// that was never actually drawn from there and leaves it to render.
//
// `chainOutsideList` is the sibling docs/spec.md calls out explicitly: a
// key whose only measured producer sits outside the ids given to this
// harvest call. It is never blank and never offered to the attachment
// bucket below — the value on the step record did come from a chain read,
// so writing it back in as a literal would misstate where it came from;
// build-draft.ts turns each of these into its own comment instead.

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `record.args` is `unknown` on the step record type (docs/spec.md
 * "Records": exactly what `--args` deserialized to, uncoerced) — a `do`
 * record whose args failed validation before ever becoming an object (a
 * bare string, a number, `--args '[]'`) has no keys to look up at all, so
 * this collapses that case to `{}` rather than making every caller repeat
 * the same guard. */
export function toArgsRecord(record: StepRecord): Record<string, unknown> {
  return isPlainRecord(record.args) ? record.args : {};
}

/** Structural equality over the JSON-safe values a step record's own
 * `args`/`result` are built from (string/number/boolean/null, plus arrays
 * and plain objects of the same) — never invoked on anything else, so this
 * does not need to handle `Date`, `Map`, or any other referenced type a
 * general-purpose deep-equal would. Exported for build-draft.ts's own round
 * trip, the other place this repo's task needs "are these two JSON-safe
 * values the same" without a third re-derivation. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

export interface ChainOutsideList {
  readonly producerStep: string;
  readonly stepRecordId: string;
}

export interface CategorizedArgs {
  readonly chainKeys: ReadonlySet<string>;
  readonly chainOutsideList: ReadonlyMap<string, ChainOutsideList>;
  readonly attachment?: Attachment;
  /** Every remaining required key this line cannot fill at all — no
   * capture, no confirmed chain, and (whether because more than one such
   * key remained, or because the one that did remain held a value no
   * docstring/table can carry) no attachment either. */
  readonly unfillable: readonly { readonly key: string; readonly value: unknown }[];
}

/**
 * Whether `entry` (a `used` entry from `record`) is evidence that `key`'s
 * value came from `entry`'s own execution: `entry.step` must name one of
 * `key`'s declared `from` candidates, `entry.step_record_id` must be one
 * this harvest call was actually given, and — the value check this file's
 * own header explains — that execution's own recorded result at the
 * candidate's named field must equal `args[key]`.
 */
function confirmedChainSource(
  key: string,
  fromEntry: Step["from"][string],
  args: Record<string, unknown>,
  stepRecordId: string,
  producerStepName: string,
  harvestedIds: ReadonlySet<string>,
  recordsById: ReadonlyMap<string, StepRecord>,
  stepNameOf: ReadonlyMap<Step, string>,
): boolean {
  if (!harvestedIds.has(stepRecordId)) {
    return false;
  }
  const producerRecord = recordsById.get(stepRecordId);
  if (producerRecord === undefined || producerRecord.status !== "ok") {
    return false;
  }
  if (!isPlainRecord(producerRecord.result)) {
    return false;
  }
  for (const [candidateStep, upstreamKey] of fromCandidates(fromEntry)) {
    if (stepNameOf.get(candidateStep) !== producerStepName) {
      continue;
    }
    if (upstreamKey in producerRecord.result && deepEqual(producerRecord.result[upstreamKey], args[key])) {
      return true;
    }
  }
  return false;
}

export function categorizeArgs(
  step: Step,
  record: StepRecord,
  captureKeys: ReadonlySet<string>,
  harvestedIds: ReadonlySet<string>,
  recordsById: ReadonlyMap<string, StepRecord>,
  stepNameOf: ReadonlyMap<Step, string>,
): CategorizedArgs {
  const shape = asObjectShape(step.args);
  const args = toArgsRecord(record);
  if (shape === undefined) {
    return { chainKeys: new Set(), chainOutsideList: new Map(), unfillable: [] };
  }

  const remaining = Object.entries(shape)
    .filter(([key, fieldSchema]) => !captureKeys.has(key) && isRequiredField(fieldSchema))
    .map(([key]) => key);

  const used = record.used ?? [];
  const chainKeys = new Set<string>();
  const chainOutsideList = new Map<string, ChainOutsideList>();
  const attachmentCandidates: string[] = [];

  for (const key of remaining) {
    const fromEntry = step.from[key];
    if (fromEntry === undefined) {
      attachmentCandidates.push(key);
      continue;
    }

    const candidateStepNames = new Set(
      fromCandidates(fromEntry).map(([candidateStep]) => stepNameOf.get(candidateStep)),
    );
    let confirmed = false;
    let outside: ChainOutsideList | undefined;
    for (const usedEntry of used) {
      if (!candidateStepNames.has(usedEntry.step)) {
        continue;
      }
      if (confirmedChainSource(key, fromEntry, args, usedEntry.step_record_id, usedEntry.step, harvestedIds, recordsById, stepNameOf)) {
        confirmed = true;
        break;
      }
      // Not confirmed: either this producer's id sits outside the given
      // ids (this key can only be named, never blanked — see this file's
      // own header), or its id is in the list but its own recorded value
      // disagrees with `args[key]` (this file's own header: the same
      // producer filled a *different* key of this step, and `--args`
      // itself supplied this one) — only the first of those two is
      // `chainOutsideList`'s own case; the second falls through to the
      // attachment/unfillable buckets below, unmarked, exactly as if `used`
      // had never cited this producer for this key at all.
      if (!harvestedIds.has(usedEntry.step_record_id)) {
        outside ??= { producerStep: usedEntry.step, stepRecordId: usedEntry.step_record_id };
      }
    }

    if (confirmed) {
      chainKeys.add(key);
    } else if (outside !== undefined) {
      chainOutsideList.set(key, outside);
    } else {
      attachmentCandidates.push(key);
    }
  }

  if (attachmentCandidates.length === 0) {
    return { chainKeys, chainOutsideList, unfillable: [] };
  }
  if (attachmentCandidates.length > 1) {
    return {
      chainKeys,
      chainOutsideList,
      unfillable: attachmentCandidates.map((key) => ({ key, value: args[key] })),
    };
  }

  const key = attachmentCandidates[0]!;
  const value = args[key];
  if (typeof value === "string") {
    return { chainKeys, chainOutsideList, attachment: { kind: "docstring", key, value }, unfillable: [] };
  }
  if (Array.isArray(value) && value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))) {
    return {
      chainKeys,
      chainOutsideList,
      attachment: { kind: "table", key, value: value as readonly (readonly string[])[] },
      unfillable: [],
    };
  }
  return { chainKeys, chainOutsideList, unfillable: [{ key, value }] };
}
