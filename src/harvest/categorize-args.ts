import { asObjectShape, isRequiredField } from "../binding/schema-shape.js";
import type { StepRecord } from "../record/types.js";
import { malformedFromEntryMessage, tryFromCandidates, type Step } from "../step/define-step.js";
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
//
// A measured optional or defaulted key is a different question from a
// required one. The line can run without it, so `nuka check` stays silent,
// and this draft is the only place the value the exploration chose can be
// written down. Leaving it off makes a later run follow the schema instead
// of that path. A value the schema would produce on its own (the record
// merely echoes a default) stays unnamed: writing it would not change what
// that later run does.

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
  /** Measured keys the line does not bind and the schema would not
   * reproduce: not required, not a capture, not a confirmed chain. The
   * draft names each one so a later run is not the only reader of the
   * value the exploration chose. */
  readonly omittedMeasured: readonly { readonly key: string; readonly value: unknown }[];
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
  const candidates = tryFromCandidates(fromEntry);
  if (candidates === null) {
    throw new Error(malformedFromEntryMessage(key, fromEntry));
  }
  for (const [candidateStep, upstreamKey] of candidates) {
    if (stepNameOf.get(candidateStep) !== producerStepName) {
      continue;
    }
    if (upstreamKey in producerRecord.result && deepEqual(producerRecord.result[upstreamKey], args[key])) {
      return true;
    }
  }
  return false;
}

type KeyDisposition =
  | { readonly kind: "chain" }
  | { readonly kind: "outside"; readonly outside: ChainOutsideList }
  | { readonly kind: "literal" };

/**
 * Where a non-capture key's measured value came from. `literal` means this
 * harvest has to account for the value itself: no confirmed chain, and no
 * producer sitting outside the ids this call was given.
 */
function keyDisposition(
  key: string,
  step: Step,
  args: Record<string, unknown>,
  harvestedIds: ReadonlySet<string>,
  recordsById: ReadonlyMap<string, StepRecord>,
  stepNameOf: ReadonlyMap<Step, string>,
  used: readonly { readonly step: string; readonly step_record_id: string }[],
): KeyDisposition {
  const fromEntry = step.from[key];
  if (fromEntry === undefined) {
    return { kind: "literal" };
  }
  const candidates = tryFromCandidates(fromEntry);
  if (candidates === null) {
    throw new Error(malformedFromEntryMessage(key, fromEntry));
  }
  const candidateStepNames = new Set(candidates.map(([candidateStep]) => stepNameOf.get(candidateStep)));
  let outside: ChainOutsideList | undefined;
  for (const usedEntry of used) {
    if (!candidateStepNames.has(usedEntry.step)) {
      continue;
    }
    if (confirmedChainSource(key, fromEntry, args, usedEntry.step_record_id, usedEntry.step, harvestedIds, recordsById, stepNameOf)) {
      return { kind: "chain" };
    }
    // Not confirmed: either this producer's id sits outside the given
    // ids (this key can only be named, never blanked; see this file's
    // own header), or its id is in the list but its own recorded value
    // disagrees with `args[key]` (this file's own header: the same
    // producer filled a different key of this step, and `--args`
    // itself supplied this one). Only the first of those two is
    // `chainOutsideList`'s own case. The second falls through to the
    // attachment/unfillable buckets below, unmarked, exactly as if `used`
    // had never cited this producer for this key at all.
    if (!harvestedIds.has(usedEntry.step_record_id)) {
      outside ??= { producerStep: usedEntry.step, stepRecordId: usedEntry.step_record_id };
    }
  }
  if (outside !== undefined) {
    return { kind: "outside", outside };
  }
  return { kind: "literal" };
}

/**
 * True when dropping `key` and parsing again yields the same value the
 * record already holds. That is a schema default the record echoes, not a
 * value the exploration chose: a later run of the line produces it too, so
 * the draft has nothing extra to name. A parse that cannot put the value
 * back (the key is simply absent, or the schema rejects the remainder)
 * returns false, and the caller names the measured value instead of
 * guessing that the schema would have.
 */
function isReproducedWithoutKey(step: Step, args: Record<string, unknown>, key: string): boolean {
  const rest: Record<string, unknown> = { ...args };
  delete rest[key];
  const parsed = step.args.safeParse(rest);
  if (!parsed.success || !isPlainRecord(parsed.data)) {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(parsed.data, key)) {
    return false;
  }
  return deepEqual(parsed.data[key], args[key]);
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
    return { chainKeys: new Set(), chainOutsideList: new Map(), unfillable: [], omittedMeasured: [] };
  }

  const used = record.used ?? [];
  const chainKeys = new Set<string>();
  const chainOutsideList = new Map<string, ChainOutsideList>();
  const attachmentCandidates: string[] = [];
  const omittedMeasured: { key: string; value: unknown }[] = [];

  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (captureKeys.has(key)) {
      continue;
    }
    const required = isRequiredField(fieldSchema);
    // An optional key the record does not hold was not measured. Naming it
    // would invent a value the exploration never supplied.
    if (!required && !Object.prototype.hasOwnProperty.call(args, key)) {
      continue;
    }
    const disposition = keyDisposition(key, step, args, harvestedIds, recordsById, stepNameOf, used);
    if (disposition.kind === "chain") {
      chainKeys.add(key);
      continue;
    }
    if (disposition.kind === "outside") {
      chainOutsideList.set(key, disposition.outside);
      continue;
    }
    if (!required && isReproducedWithoutKey(step, args, key)) {
      continue;
    }
    if (required) {
      attachmentCandidates.push(key);
    } else {
      omittedMeasured.push({ key, value: args[key] });
    }
  }

  if (attachmentCandidates.length === 0) {
    return { chainKeys, chainOutsideList, unfillable: [], omittedMeasured };
  }
  if (attachmentCandidates.length > 1) {
    return {
      chainKeys,
      chainOutsideList,
      unfillable: attachmentCandidates.map((key) => ({ key, value: args[key] })),
      omittedMeasured,
    };
  }

  const key = attachmentCandidates[0]!;
  const value = args[key];
  if (typeof value === "string") {
    return { chainKeys, chainOutsideList, attachment: { kind: "docstring", key, value }, unfillable: [], omittedMeasured };
  }
  if (Array.isArray(value) && value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))) {
    return {
      chainKeys,
      chainOutsideList,
      attachment: { kind: "table", key, value: value as readonly (readonly string[])[] },
      unfillable: [],
      omittedMeasured,
    };
  }
  return { chainKeys, chainOutsideList, unfillable: [{ key, value }], omittedMeasured };
}
