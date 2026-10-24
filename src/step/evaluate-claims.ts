import type {
  ClaimCompare,
  ClaimComparisonRecord,
  ClaimEachRecord,
  ClaimItemRecord,
  ClaimOutcome,
  ClaimView,
} from "../record/types.js";
import {
  isEachClaim,
  literalStatedByAll,
  pathSegments,
  type Claim,
  type ClaimExpected,
  type ClaimLiteral,
  type ItemClaim,
} from "./claims.js";

// Responsibility: judging a claim step's claims against the values it read
// (docs/spec.md "Claims"). Every function here is pure: the runner reads
// the world (`observe`, the `from` values) and hands the values in, and
// what comes back is the record of each claim with the raw actual value
// beside it, so the runner can look for the channel it was measured on.
// The poll loop is here too, with its clock and its reader injected, so
// the two-consecutive-holds rule is tested without a page.

/** The JSON type a compare sees. `undefined` never reaches a compare: an
 * undefined side breaks first, naming its path. */
export type JsonType = "null" | "array" | "object" | "string" | "number" | "boolean" | "bigint";

export function jsonType(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean" || type === "bigint") return type;
  return "object";
}

/** The value at `path` inside `root`, or `undefined` when a segment holds
 * nothing. An array segment is a decimal index; nothing else is read from
 * an array, so `length` is not a path into one. Pure. */
export function valueAt(root: unknown, path: string): unknown {
  const segments = pathSegments(path);
  if (segments === null) return undefined;
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (typeof current === "object" && current !== null && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Structural equality over JSON values: object key order does not count,
 * and 0 equals -0, since JSON text writes both as 0. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b || Object.is(a, b)) return true;
  const type = jsonType(a);
  if (type !== jsonType(b)) return false;
  if (type === "array") {
    const left = a as unknown[];
    const right = b as unknown[];
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (type === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

/** The value after `view`, or why the view could not apply. */
export function applyView(view: ClaimView | undefined, value: unknown): { readonly value: unknown } | { readonly reason: string } {
  if (view === undefined) return { value };
  if (typeof value !== "string") return { reason: `view ${view} reads a string, and the value is a ${jsonType(value)}` };
  switch (view) {
    case "text":
      return { value: value.trimEnd() };
    case "lines": {
      const text = value.trimEnd();
      return { value: text === "" ? [] : text.split(/\r?\n/) };
    }
    case "json":
      try {
        return { value: JSON.parse(value) as unknown };
      } catch (error) {
        return { reason: `view json could not parse the value: ${error instanceof Error ? error.message : String(error)}` };
      }
  }
}

/** Whether `actual <compare> expected` holds, or why the two sides cannot
 * be compared at all. A comparison across two JSON types never holds for
 * the reason the claim states (a string is never equal to a number), so it
 * breaks with both types named. Pure. */
export function compareValues(
  compare: ClaimCompare,
  actual: unknown,
  expected: unknown,
): { readonly holds: boolean } | { readonly reason: string } {
  const actualType = jsonType(actual);
  const expectedType = jsonType(expected);
  switch (compare) {
    case "equal":
    case "not-equal": {
      if (actualType !== expectedType) return { reason: `${compare} compares a ${actualType} with a ${expectedType}` };
      const same = deepEqual(actual, expected);
      return { holds: compare === "equal" ? same : !same };
    }
    case "contains-text":
    case "matches": {
      if (actualType !== "string" || expectedType !== "string") {
        return { reason: `${compare} reads two strings, and compares a ${actualType} with a ${expectedType}` };
      }
      if (expected === "") return { reason: `${compare} has an empty expected value, which every string holds` };
      if (compare === "contains-text") return { holds: (actual as string).includes(expected as string) };
      let pattern: RegExp;
      try {
        pattern = new RegExp(expected as string);
      } catch (error) {
        return { reason: `matches could not build a regular expression: ${error instanceof Error ? error.message : String(error)}` };
      }
      return { holds: pattern.test(actual as string) };
    }
    case "has-item": {
      if (actualType !== "array") return { reason: `has-item reads an array, and the actual value is a ${actualType}` };
      const items = actual as unknown[];
      if (items.length > 0 && !items.some((item) => jsonType(item) === expectedType)) {
        return { reason: `has-item looks for a ${expectedType}, and no item is one` };
      }
      return { holds: items.some((item) => deepEqual(item, expected)) };
    }
    case "greater-than":
    case "at-least":
    case "less-than":
    case "at-most": {
      const numeric = (actualType === "number" && expectedType === "number") || (actualType === "bigint" && expectedType === "bigint");
      if (!numeric) return { reason: `${compare} compares two numbers, and compares a ${actualType} with a ${expectedType}` };
      const a = actual as number;
      const e = expected as number;
      if (compare === "greater-than") return { holds: a > e };
      if (compare === "at-least") return { holds: a >= e };
      if (compare === "less-than") return { holds: a < e };
      return { holds: a <= e };
    }
  }
}

/** What a claim step read, and how to name each value's source. */
export interface ClaimInputs {
  /** The step's validated args: sentence values and `from` values. */
  readonly args: Readonly<Record<string, unknown>>;
  /** What `observe` returned, or `undefined` for a step without one. */
  readonly observation: unknown;
  readonly fromKeys: ReadonlySet<string>;
  /** The source of an args key without a path: `sentence:<key>`, or
   * `from:<step>@<line>.<returns key>` for a key an earlier step filled. */
  readonly argLabel: (key: string) => string;
  readonly patterns: readonly string[];
}

/** One claim as judged, with the raw actual value (before `view` and
 * `at`) the runner compares with each recorded channel, and the args key
 * it was read from (`null` for a value `observe` returned). */
export interface JudgedClaim {
  readonly record: ClaimComparisonRecord | ClaimEachRecord;
  readonly rawActual: unknown;
  readonly fromKey: string | null;
}

interface Side {
  readonly value: unknown;
  readonly label: string;
}

function readTopLevel(path: string, inputs: ClaimInputs): Side & { readonly fromKey: string | null } {
  const head = pathSegments(path)?.[0] ?? "";
  const rest = path.slice(head.length);
  if (inputs.fromKeys.has(head)) {
    return { value: valueAt(inputs.args, path), label: `${inputs.argLabel(head)}${rest}`, fromKey: head };
  }
  return { value: valueAt(inputs.observation, path), label: `observe:${path}`, fromKey: null };
}

function readExpected(expected: ClaimExpected, inputs: ClaimInputs): Side {
  if (typeof expected === "string") {
    return { value: inputs.args[expected], label: inputs.argLabel(expected) };
  }
  if ("from" in expected) {
    const head = pathSegments(expected.from)?.[0] ?? "";
    return { value: valueAt(inputs.args, expected.from), label: `${inputs.argLabel(head)}${expected.from.slice(head.length)}` };
  }
  if ("observe" in expected) {
    return { value: valueAt(inputs.observation, expected.observe), label: `observe:${expected.observe}` };
  }
  const words = literalStatedByAll(inputs.patterns, expected.literal);
  return { value: literalValue(expected.literal), label: `literal:${words ?? "unstated"}` };
}

function literalValue(literal: ClaimLiteral): unknown {
  return Array.isArray(literal) ? [] : literal;
}

/** The value after `view` and `at`, with its label, or why there is none. */
function shapeActual(side: Side, claim: { readonly view?: ClaimView; readonly at?: string }, path: string): { readonly value: unknown } | { readonly reason: string } {
  if (side.value === undefined) return { reason: `${path} is undefined` };
  const viewed = applyView(claim.view, side.value);
  if ("reason" in viewed) return viewed;
  if (claim.at === undefined) return viewed;
  const value = valueAt(viewed.value, claim.at);
  return value === undefined ? { reason: `${path}${claim.view === undefined ? "" : ` as ${claim.view}`} has nothing at ${claim.at}` } : { value };
}

function judgeComparison(
  claim: ItemClaim,
  actual: Side,
  actualPath: string,
  inputs: ClaimInputs,
): ClaimComparisonRecord {
  const expected = readExpected(claim.expected, inputs);
  const shaped = shapeActual(actual, claim, actualPath);
  // Field order is the order a reader reads a claim in: what was measured,
  // how, and what it was compared with.
  const base = {
    ...("reason" in shaped ? {} : { actual: shaped.value }),
    actual_from: actual.label,
    ...(claim.view === undefined ? {} : { view: claim.view }),
    ...(claim.at === undefined ? {} : { at: claim.at }),
    compare: claim.compare,
    ...(expected.value === undefined ? {} : { expected: expected.value }),
    expected_from: expected.label,
  };
  if ("reason" in shaped) return { ...base, outcome: "broken", reason: shaped.reason };
  if (expected.value === undefined) return { ...base, outcome: "broken", reason: `the expected value ${expected.label} is undefined` };
  if (actual.label === expected.label) {
    return { ...base, outcome: "broken", reason: `both sides are ${actual.label}, so the claim compares a value with itself` };
  }
  const result = compareValues(claim.compare, shaped.value, expected.value);
  if ("reason" in result) return { ...base, outcome: "broken", reason: result.reason };
  return { ...base, outcome: result.holds ? "held" : "broken" };
}

/** At most this many items of one `each` are kept on the record. */
export const EACH_RESULTS_CAP = 20;

function itemSide(item: unknown, claim: ItemClaim, itemLabel: string): { readonly side: Side; readonly path: string } {
  if (claim.actual === undefined) return { side: { value: item, label: itemLabel }, path: itemLabel };
  return { side: { value: valueAt(item, claim.actual), label: `${itemLabel}.${claim.actual}` }, path: `${itemLabel}.${claim.actual}` };
}

function judgeEach(claim: Claim & { readonly each: NonNullable<Claim["each"]> }, actual: Side, inputs: ClaimInputs): ClaimEachRecord {
  const base = {
    actual_from: actual.label,
    ...(claim.view === undefined ? {} : { view: claim.view }),
    ...(claim.at === undefined ? {} : { at: claim.at }),
  };
  const emptyEach = { items: 0, selected: 0, results: [] as ClaimItemRecord[] };
  const shaped = shapeActual(actual, claim, claim.actual);
  if ("reason" in shaped) return { ...base, each: emptyEach, outcome: "broken", reason: shaped.reason };
  if (!Array.isArray(shaped.value)) {
    return { ...base, each: emptyEach, outcome: "broken", reason: `each reads an array, and the value is a ${jsonType(shaped.value)}` };
  }
  const items: unknown[] = shaped.value;
  if (items.length === 0) {
    return { ...base, each: emptyEach, outcome: "broken", reason: "the array is empty, and a claim on every item of nothing measures nothing" };
  }
  const judged: ClaimItemRecord[] = [];
  items.forEach((item, index) => {
    const itemLabel = `${actual.label}[${index}]`;
    const selected = (claim.each.where ?? []).every((where) => {
      const { side, path } = itemSide(item, where, itemLabel);
      return judgeComparison(where, side, path, inputs).outcome === "held";
    });
    if (!selected) return;
    const claims = claim.each.claims.map((itemClaim) => {
      const { side, path } = itemSide(item, itemClaim, itemLabel);
      return judgeComparison(itemClaim, side, path, inputs);
    });
    judged.push({ index, outcome: claims.every((entry) => entry.outcome === "held") ? "held" : "broken", claims });
  });
  if (judged.length === 0) {
    return {
      ...base,
      each: { items: items.length, selected: 0, results: [] },
      outcome: "broken",
      reason: `where selected none of the ${items.length} items, and a claim on none of them measures nothing`,
    };
  }
  const broken = judged.filter((entry) => entry.outcome === "broken");
  const kept = [...broken.slice(0, EACH_RESULTS_CAP), ...judged.filter((entry) => entry.outcome === "held")]
    .slice(0, EACH_RESULTS_CAP)
    .sort((a, b) => a.index - b.index);
  return {
    ...base,
    each: {
      items: items.length,
      selected: judged.length,
      results: kept,
      ...(judged.length > kept.length ? { results_truncated: judged.length } : {}),
    },
    outcome: broken.length === 0 ? "held" : "broken",
  };
}

/** Judges every claim against what the step read. Pure. */
export function evaluateClaims(claims: readonly Claim[], inputs: ClaimInputs): readonly JudgedClaim[] {
  return claims.map((claim): JudgedClaim => {
    const actual = readTopLevel(claim.actual, inputs);
    const record = isEachClaim(claim)
      ? judgeEach(claim, actual, inputs)
      : judgeComparison(claim, actual, claim.actual, inputs);
    return { record, rawActual: actual.value, fromKey: actual.fromKey };
  });
}

/** Each claim's record when the step could not read its values: what
 * each side would have been named, nothing compared. */
export function unobservedClaims(claims: readonly Claim[], inputs: Omit<ClaimInputs, "args" | "observation"> & { readonly args: Readonly<Record<string, unknown>> }): readonly JudgedClaim[] {
  return claims.map((claim): JudgedClaim => {
    const actual = readTopLevel(claim.actual, { ...inputs, observation: undefined });
    const base = {
      actual_from: actual.label,
      ...(claim.view === undefined ? {} : { view: claim.view }),
      ...(claim.at === undefined ? {} : { at: claim.at }),
    };
    const outcome: ClaimOutcome = "unobserved";
    if (isEachClaim(claim)) {
      return { record: { ...base, each: { items: 0, selected: 0, results: [] }, outcome }, rawActual: undefined, fromKey: actual.fromKey };
    }
    const expected = readExpected(claim.expected, { ...inputs, observation: undefined });
    return {
      record: { ...base, compare: claim.compare, expected_from: expected.label, outcome },
      rawActual: undefined,
      fromKey: actual.fromKey,
    };
  });
}

// --- poll ---

/** One reading: what `observe` returned, or what it threw. */
export type Reading = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };

export interface PollClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** The pause between two readings, so the confirming reading is a later
 * frame and not the same one read twice. */
export const POLL_INTERVAL_MS = 100;

/**
 * Reads until `holds` is true for two consecutive readings, or the deadline
 * passes; returns the last reading and how many there were. One reading
 * that holds is never enough on its own: a page between two renders can
 * show the expected state for one frame. When the deadline passes right
 * after a first hold, one more reading confirms it, so a pass always rests
 * on two. A reading that threw counts as not holding.
 */
export async function pollReadings(
  read: () => Promise<Reading>,
  holds: (value: unknown) => boolean,
  timeoutMs: number,
  clock: PollClock,
): Promise<{ readonly last: Reading; readonly attempts: number }> {
  const deadline = clock.now() + timeoutMs;
  let consecutive = 0;
  let attempts = 0;
  let last: Reading;
  for (;;) {
    last = await read();
    attempts += 1;
    consecutive = last.ok && holds(last.value) ? consecutive + 1 : 0;
    if (consecutive >= 2) break;
    if (consecutive === 0 && clock.now() >= deadline) break;
    await clock.sleep(POLL_INTERVAL_MS);
  }
  return { last, attempts };
}
