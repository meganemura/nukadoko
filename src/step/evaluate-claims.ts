import type {
  ClaimCompare,
  ClaimComparisonRecord,
  ClaimEachRecord,
  ClaimItemDeclaration,
  ClaimItemRecord,
  ClaimView,
} from "../record/types.js";
import {
  isEachClaim,
  literalStatedByAll,
  pathSegments,
  placeAt,
  placeViewed,
  samePlace,
  type Claim,
  type ClaimLiteral,
  type ClaimPlace,
  type EachClaim,
  type ItemClaim,
} from "./claims.js";

// Responsibility: judging a claim step's claims against the values it read
// (docs/spec.md "Claims"). The runner reads the world (`observe`, the
// `from` values) and hands the values in, with a way to test a regular
// expression that it can stop; what comes back is the record of each claim
// with the raw actual value beside it, so the runner can look for the
// channel it was measured on. Every function here is pure except for the
// pattern tester it is given. The poll loop is here too, with its clock and
// its reader injected, so the two-consecutive-holds rule is tested without
// a page.
//
// A compare reads plain JSON only. A value JSON cannot hold (a Date, a Map,
// a bigint, NaN, a getter) would print one way in the record and compare
// another way, so a claim on one breaks and names it, and what the record
// shows is always what was compared.

/** The JSON type a compare sees. `undefined` never reaches a compare: an
 * undefined side breaks first, naming its path, and so does any value that
 * is not plain JSON. */
export type JsonType = "null" | "array" | "object" | "string" | "number" | "boolean";

export function jsonType(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return type;
  return "object";
}

const INDEX = /^(0|[1-9][0-9]*)$/;

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

function kindOf(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return String(value);
    return `the integer ${String(value)}, beyond Number.MAX_SAFE_INTEGER`;
  }
  if (typeof value === "bigint") return `the bigint ${String(value)}n`;
  if (typeof value === "function") return "a function";
  if (typeof value === "symbol") return "a symbol";
  const prototype = Object.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null;
  const name = prototype?.constructor?.name;
  return typeof name === "string" && name.length > 0 ? article(name) : "an object of no class";
}

/**
 * The first part of `value` that is not plain JSON, as `<where> is <what>`,
 * or `null`. Plain JSON is `null`, a boolean, a string, a finite number that
 * is not an integer beyond `Number.MAX_SAFE_INTEGER`, an array with no
 * holes and no other keys, or an object whose prototype is
 * `Object.prototype` or `null` and whose own properties are all enumerable
 * data properties with string keys. `where` names the root. Pure.
 */
export function nonJsonPart(value: unknown, where: string): string | null {
  const seen = new Set<object>();
  const visit = (current: unknown, at: string): string | null => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return null;
    if (typeof current === "number") {
      return Number.isFinite(current) && (!Number.isInteger(current) || Number.isSafeInteger(current)) ? null : `${at} is ${kindOf(current)}`;
    }
    if (typeof current !== "object") return `${at} is ${kindOf(current)}`;
    if (seen.has(current)) return `${at} refers back to a value that holds it`;
    const isArray = Array.isArray(current);
    const prototype: unknown = Object.getPrototypeOf(current);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      return `${at} is ${kindOf(current)}`;
    }
    seen.add(current);
    const keys = Reflect.ownKeys(current);
    if (isArray) {
      const items = current as unknown[];
      for (let index = 0; index < items.length; index += 1) {
        if (!Object.hasOwn(items, index)) return `${at}.${index} is a hole`;
      }
    }
    for (const key of keys) {
      if (typeof key === "symbol") return `${at} has a symbol key`;
      if (isArray && key === "length") continue;
      if (isArray && !INDEX.test(key)) return `${at} has the key "${key}" beside its items`;
      const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
      if (!("value" in descriptor)) return `${at}.${key} is a getter`;
      if (descriptor.enumerable !== true) return `${at}.${key} is not enumerable`;
      const problem = visit(descriptor.value, `${at}.${key}`);
      if (problem !== null) return problem;
    }
    seen.delete(current);
    return null;
  };
  return visit(value, where);
}

/** What walking a path found: a value, nothing at a segment, or a
 * property that would run code to be read. */
type PathRead =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "missing"; readonly at: number }
  | { readonly kind: "getter"; readonly at: number };

/** Walks `segments` from `root` by own data properties only, so no path
 * reaches `Object.prototype` and no getter runs. An array segment is a
 * decimal index; nothing else is read from an array, so `length` is not a
 * path into one. Pure. */
function readPath(root: unknown, segments: readonly string[]): PathRead {
  let current: unknown = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (Array.isArray(current) && !INDEX.test(segment)) return { kind: "missing", at: index };
    if (typeof current !== "object" || current === null) return { kind: "missing", at: index };
    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    if (descriptor === undefined) return { kind: "missing", at: index };
    if (!("value" in descriptor)) return { kind: "getter", at: index };
    current = descriptor.value;
  }
  return { kind: "value", value: current };
}

/** The value at `path` inside `root`, or `undefined` when a segment holds
 * nothing or names a getter. Pure. */
export function valueAt(root: unknown, path: string): unknown {
  const segments = pathSegments(path);
  if (segments === null) return undefined;
  const read = readPath(root, segments);
  return read.kind === "value" ? read.value : undefined;
}

/** Structural equality over plain JSON values: object key order does not
 * count, and 0 equals -0, since JSON text writes both as 0. */
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
  if (typeof value !== "string") return { reason: `view ${view} reads a string, and the value is ${typeof value === "object" ? article(jsonType(value)) : article(typeof value)}` };
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

/** What testing a regular expression found: whether it matches the text
 * and whether it matches the empty string, or why it could not be tested
 * (it does not build, or it ran past the step's deadline). */
export type PatternOutcome = { readonly holds: boolean; readonly matchesEmpty: boolean } | { readonly reason: string };

/** Tests `pattern` against `text`. The runner gives one that runs where it
 * can be stopped, since a pattern that backtracks can run for longer than
 * the step may. It throws only when it could not test at all. */
export type PatternTester = (pattern: string, text: string) => Promise<PatternOutcome>;

/** Whether `actual <compare> expected` holds, or why the two sides cannot
 * be compared at all. Both sides are plain JSON. A comparison across two
 * JSON types never holds for the reason the claim states (a string is never
 * equal to a number), so it breaks with both types named. An expected text
 * every string holds (an empty or blank text, a pattern that matches the
 * empty string) breaks too. */
export async function compareValues(
  compare: ClaimCompare,
  actual: unknown,
  expected: unknown,
  testPattern: PatternTester,
): Promise<{ readonly holds: boolean } | { readonly reason: string }> {
  const actualType = jsonType(actual);
  const expectedType = jsonType(expected);
  switch (compare) {
    case "equal":
    case "not-equal": {
      if (actualType !== expectedType) return { reason: `${compare} compares ${article(actualType)} with ${article(expectedType)}` };
      const same = deepEqual(actual, expected);
      return { holds: compare === "equal" ? same : !same };
    }
    case "contains-text":
    case "matches": {
      if (actualType !== "string" || expectedType !== "string") {
        return { reason: `${compare} reads two strings, and compares ${article(actualType)} with ${article(expectedType)}` };
      }
      const text = expected as string;
      if (compare === "contains-text") {
        if (text.trim() === "") return { reason: "contains-text has an expected text of only whitespace or nothing, which almost every string holds" };
        return { holds: (actual as string).includes(text) };
      }
      if (text === "") return { reason: "matches has an empty expected value, which every string holds" };
      const tested = await testPattern(text, actual as string);
      if ("reason" in tested) return tested;
      if (tested.matchesEmpty) return { reason: `matches has a pattern that matches the empty string, so every string holds it` };
      return { holds: tested.holds };
    }
    case "has-item": {
      if (actualType !== "array") return { reason: `has-item reads an array, and the actual value is ${article(actualType)}` };
      const items = actual as unknown[];
      if (items.length > 0 && !items.some((item) => jsonType(item) === expectedType)) {
        return { reason: `has-item looks for ${article(expectedType)}, and no item is one` };
      }
      return { holds: items.some((item) => deepEqual(item, expected)) };
    }
    case "greater-than":
    case "at-least":
    case "less-than":
    case "at-most": {
      if (actualType !== "number" || expectedType !== "number") {
        return { reason: `${compare} compares two numbers, and compares ${article(actualType)} with ${article(expectedType)}` };
      }
      const a = actual as number;
      const e = expected as number;
      if (compare === "greater-than") return { holds: a > e };
      if (compare === "at-least") return { holds: a >= e };
      if (compare === "less-than") return { holds: a < e };
      return { holds: a <= e };
    }
  }
}

/** Where an args key's value starts: the origin two sides are compared by,
 * the path inside it, and the label the record names it by. */
export interface ArgSide {
  readonly origin: string;
  readonly segments: readonly string[];
  readonly label: string;
}

/** What a claim step read, and how to name each value's source. */
export interface ClaimInputs {
  /** The step's validated args: sentence values and `from` values. */
  readonly args: Readonly<Record<string, unknown>>;
  /** What `observe` returned, or `undefined` for a step without one. */
  readonly observation: unknown;
  readonly fromKeys: ReadonlySet<string>;
  /** Where an args key's value starts: `sentence:<key>` for a value the
   * line states, `from:<step>@<line>.<returns key>` for a value an earlier
   * step returned. */
  readonly argSide: (key: string) => ArgSide;
  /** The text the line states an args key as: a capture's text, the
   * docstring, or the table; `null` for a key the line does not fill. */
  readonly sentenceText: (key: string) => string | null;
  readonly patterns: readonly string[];
  readonly testPattern: PatternTester;
}

/** One claim as judged, with the raw actual value (before `view` and
 * `at`) the runner compares with each recorded channel, and the args key
 * it was read from (`null` for a value `observe` returned). */
export interface JudgedClaim {
  readonly record: ClaimComparisonRecord | ClaimEachRecord;
  readonly rawActual: unknown;
  readonly fromKey: string | null;
}

/** A value read at a place, or why there is none. */
type Side =
  | { readonly place: ClaimPlace; readonly value: unknown }
  | { readonly place: ClaimPlace; readonly reason: string };

function argPlace(key: string, inputs: ClaimInputs): ClaimPlace {
  const side = inputs.argSide(key);
  return { origin: side.origin, segments: side.segments, label: side.label, open: false };
}

const OBSERVE_PLACE: ClaimPlace = { origin: "observe", segments: [], label: "observe:", open: false };

/** Reads `place`'s value from `root`, starting at `from`, which is where
 * `root` sits in `place`. `name` is how a reason names the side. */
function readSide(root: unknown, place: ClaimPlace, from: number, name = place.label): Side {
  const read = readPath(root, place.segments.slice(from));
  if (read.kind === "getter") return { place, reason: `${name} reads a getter, which is not a JSON value` };
  if (read.kind === "value" && read.value !== undefined) return { place, value: read.value };
  return { place, reason: `${name} is undefined` };
}

/** The top-level side a claim's `actual` names, before `view` and `at`. */
function topLevelSide(path: string, inputs: ClaimInputs): Side & { readonly fromKey: string | null } {
  const segments = pathSegments(path) ?? [path];
  const head = segments[0]!;
  if (inputs.fromKeys.has(head)) {
    const base = argPlace(head, inputs);
    const place = placeAt(base, segments.slice(1).join("."));
    const side = readSide(inputs.args[head], place, base.segments.length);
    return { ...side, fromKey: head };
  }
  return { ...readSide(inputs.observation, placeAt(OBSERVE_PLACE, path), 0), fromKey: null };
}

/** A side through `view` and then `at`. */
function shaped(side: Side, view: ClaimView | undefined, at: string | undefined): Side {
  if ("reason" in side) return { place: placeAt(placeViewed(side.place, view), at), reason: side.reason };
  const viewedPlace = placeViewed(side.place, view);
  const viewed = applyView(view, side.value);
  if ("reason" in viewed) return { place: placeAt(viewedPlace, at), reason: viewed.reason };
  if (at === undefined) return { place: viewedPlace, value: viewed.value };
  const place = placeAt(viewedPlace, at);
  const read = readPath(viewed.value, at.split("."));
  if (read.kind === "value" && read.value !== undefined) return { place, value: read.value };
  return { place, reason: `${viewedPlace.label} has nothing at ${at}` };
}

/** An expected value, its place, and the text the sentence states it as. */
type ExpectedSide = Side & { readonly text: string | null; readonly fromObserve: boolean };

function expectedSide(claim: ItemClaim, inputs: ClaimInputs): ExpectedSide {
  const expected = claim.expected;
  if (typeof expected === "string") {
    const place = placeViewed(argPlace(expected, inputs), claim.expected_view);
    const text = inputs.sentenceText(expected);
    const value = inputs.args[expected];
    if (value === undefined) return { place, reason: `the expected value ${place.label} is undefined`, text, fromObserve: false };
    const viewed = applyView(claim.expected_view, value);
    return "reason" in viewed ? { place, reason: viewed.reason, text, fromObserve: false } : { place, value: viewed.value, text, fromObserve: false };
  }
  if ("from" in expected) {
    const segments = pathSegments(expected.from) ?? [expected.from];
    const base = argPlace(segments[0]!, inputs);
    const place = placeAt(base, segments.slice(1).join("."));
    const side = readSide(inputs.args[segments[0]!], place, base.segments.length, `the expected value ${place.label}`);
    return { ...side, text: null, fromObserve: false };
  }
  if ("observe" in expected) {
    const place = placeAt(OBSERVE_PLACE, expected.observe);
    const side = readSide(inputs.observation, place, 0, `the expected value ${place.label}`);
    return { ...side, text: null, fromObserve: true };
  }
  const words = literalStatedByAll(inputs.patterns, expected.literal) ?? "unstated";
  const place: ClaimPlace = { origin: "literal", segments: [], label: `literal:${words}`, open: false };
  return { place, value: literalValue(expected.literal), text: words, fromObserve: false };
}

function literalValue(literal: ClaimLiteral): unknown {
  return Array.isArray(literal) ? [] : literal;
}

/** Why a comparison of `actual` with `expected` cannot say anything about
 * the behaviour, before any compare runs, or `null`. */
function precondition(actual: Side, expected: ExpectedSide): string | null {
  if ("reason" in actual) return actual.reason;
  if ("reason" in expected) return expected.reason;
  const actualProblem = nonJsonPart(actual.value, actual.place.label);
  if (actualProblem !== null) return `${actualProblem}, not a JSON value, so the record could not show what was compared`;
  const expectedProblem = nonJsonPart(expected.value, `the expected value ${expected.place.label}`);
  if (expectedProblem !== null) return `${expectedProblem}, not a JSON value, so the record could not show what was compared`;
  if (samePlace(actual.place, expected.place)) {
    return `both sides read ${actual.place.label}, so the claim compares a value with itself`;
  }
  if (expected.fromObserve && typeof expected.value === "boolean") {
    return `the expected value ${expected.place.label} is a boolean observe computed, which is a judgment made in code: return the thing measured and let the claim compare it`;
  }
  return null;
}

function declarationOf(claim: ItemClaim, expected: ExpectedSide, withValue: boolean): ClaimItemDeclaration {
  return {
    ...(claim.actual === undefined ? {} : { actual: claim.actual }),
    ...(claim.view === undefined ? {} : { view: claim.view }),
    ...(claim.at === undefined ? {} : { at: claim.at }),
    compare: claim.compare,
    ...(withValue && "value" in expected && nonJsonPart(expected.value, "") === null ? { expected: expected.value } : {}),
    expected_from: expected.place.label,
    ...(claim.expected_view === undefined ? {} : { expected_view: claim.expected_view }),
    expected_text: expected.text,
  };
}

async function judgeComparison(claim: ItemClaim, rawActual: Side, inputs: ClaimInputs): Promise<ClaimComparisonRecord> {
  const expected = expectedSide(claim, inputs);
  const actual = shaped(rawActual, claim.view, claim.at);
  const showsActual = "value" in actual && nonJsonPart(actual.value, "") === null;
  const showsExpected = "value" in expected && nonJsonPart(expected.value, "") === null;
  // Field order is the order a reader reads a claim in: what was measured,
  // how, and what it was compared with.
  const base = {
    ...(showsActual ? { actual: actual.value } : {}),
    actual_from: actual.place.label,
    ...(claim.view === undefined ? {} : { view: claim.view }),
    ...(claim.at === undefined ? {} : { at: claim.at }),
    compare: claim.compare,
    ...(showsExpected ? { expected: expected.value } : {}),
    expected_from: expected.place.label,
    ...(claim.expected_view === undefined ? {} : { expected_view: claim.expected_view }),
    expected_text: expected.text,
  };
  const problem = precondition(actual, expected);
  if (problem !== null) return { ...base, outcome: "broken", reason: problem };
  const result = await compareValues(claim.compare, (actual as { value: unknown }).value, (expected as { value: unknown }).value, inputs.testPattern);
  if ("reason" in result) return { ...base, outcome: "broken", reason: result.reason };
  return { ...base, outcome: result.holds ? "held" : "broken" };
}

/** At most this many items of one `each` are kept on the record. */
export const EACH_RESULTS_CAP = 20;

/** The side an item claim reads: the item, or a path inside it. */
function itemSide(item: unknown, itemPlace: ClaimPlace, claim: ItemClaim): Side {
  if (claim.actual === undefined) {
    return item === undefined ? { place: itemPlace, reason: `${itemPlace.label} is undefined` } : { place: itemPlace, value: item };
  }
  return readSide(item, placeAt(itemPlace, claim.actual), itemPlace.segments.length);
}

async function judgeEach(claim: EachClaim, rawActual: Side, inputs: ClaimInputs): Promise<ClaimEachRecord> {
  const actual = shaped(rawActual, claim.view, claim.at);
  const where = claim.each.where ?? [];
  const declared = {
    ...(where.length === 0 ? {} : { where: where.map((entry) => declarationOf(entry, expectedSide(entry, inputs), true)) }),
    claims: claim.each.claims.map((entry) => declarationOf(entry, expectedSide(entry, inputs), true)),
  };
  const base = {
    actual_from: actual.place.label,
    ...(claim.view === undefined ? {} : { view: claim.view }),
    ...(claim.at === undefined ? {} : { at: claim.at }),
  };
  const broken = (reason: string, items = 0, results: readonly ClaimItemRecord[] = []): ClaimEachRecord => ({
    ...base,
    each: { ...declared, items, selected: 0, results },
    outcome: "broken",
    reason,
  });
  if ("reason" in actual) return broken(actual.reason);
  if (!Array.isArray(actual.value)) return broken(`each reads an array, and the value is ${article(jsonType(actual.value))}`);
  const items: unknown[] = actual.value;
  if (items.length === 0) return broken("the array is empty, and a claim on every item of nothing measures nothing");
  const judged: ClaimItemRecord[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const itemPlace = placeAt(actual.place, String(index));
    const whereRecords: ClaimComparisonRecord[] = [];
    for (const entry of where) {
      whereRecords.push(await judgeComparison(entry, itemSide(items[index], itemPlace, entry), inputs));
    }
    // A where claim that could not compare at all (an undefined value, two
    // JSON types) says nothing about whether the item belongs, so leaving
    // the item out would turn "every item" into "the items that happen to
    // compare".
    const unjudgeable = whereRecords.find((record) => record.reason !== undefined);
    if (unjudgeable !== undefined) {
      return broken(`where could not compare item ${index}: ${unjudgeable.reason}`, items.length, [{ index, selected: false, where: whereRecords }]);
    }
    if (!whereRecords.every((record) => record.outcome === "held")) {
      judged.push({ index, selected: false, where: whereRecords });
      continue;
    }
    const claims: ClaimComparisonRecord[] = [];
    for (const entry of claim.each.claims) {
      claims.push(await judgeComparison(entry, itemSide(items[index], itemPlace, entry), inputs));
    }
    judged.push({
      index,
      selected: true,
      ...(whereRecords.length === 0 ? {} : { where: whereRecords }),
      outcome: claims.every((entry) => entry.outcome === "held") ? "held" : "broken",
      claims,
    });
  }
  const selected = judged.filter((entry) => entry.selected);
  const kept = keptItems(judged);
  const truncated = judged.length > kept.length ? { results_truncated: judged.length } : {};
  if (selected.length === 0) {
    return {
      ...base,
      each: { ...declared, items: items.length, selected: 0, results: kept, ...truncated },
      outcome: "broken",
      reason: `where selected none of the ${items.length} items, and a claim on none of them measures nothing`,
    };
  }
  return {
    ...base,
    each: { ...declared, items: items.length, selected: selected.length, results: kept, ...truncated },
    outcome: selected.every((entry) => entry.selected && entry.outcome === "held") ? "held" : "broken",
  };
}

/** The item results the record keeps: the broken ones first, then the ones
 * `where` left out, then the ones that held, at most `EACH_RESULTS_CAP`,
 * in index order. */
function keptItems(judged: readonly ClaimItemRecord[]): ClaimItemRecord[] {
  const rank = (entry: ClaimItemRecord): number => (!entry.selected ? 1 : entry.outcome === "broken" ? 0 : 2);
  return [...judged]
    .sort((a, b) => rank(a) - rank(b) || a.index - b.index)
    .slice(0, EACH_RESULTS_CAP)
    .sort((a, b) => a.index - b.index);
}

/** Each claim's labels when nothing was compared: what each side would
 * have been named, with `outcome` and, for an unjudged claim, why. */
function notJudged(claim: Claim, inputs: ClaimInputs, outcome: "unobserved" | "unjudged", reason: string | undefined): ClaimComparisonRecord | ClaimEachRecord {
  const actual = shaped(topLevelSide(claim.actual, inputs), claim.view, claim.at);
  const tail = { outcome, ...(reason === undefined ? {} : { reason }) };
  const base = {
    actual_from: actual.place.label,
    ...(claim.view === undefined ? {} : { view: claim.view }),
    ...(claim.at === undefined ? {} : { at: claim.at }),
  };
  if (isEachClaim(claim)) {
    const where = claim.each.where ?? [];
    return {
      ...base,
      each: {
        ...(where.length === 0 ? {} : { where: where.map((entry) => declarationOf(entry, expectedSide(entry, inputs), false)) }),
        claims: claim.each.claims.map((entry) => declarationOf(entry, expectedSide(entry, inputs), false)),
        items: 0,
        selected: 0,
        results: [],
      },
      ...tail,
    };
  }
  const expected = expectedSide(claim, inputs);
  return {
    ...base,
    compare: claim.compare,
    expected_from: expected.place.label,
    ...(claim.expected_view === undefined ? {} : { expected_view: claim.expected_view }),
    expected_text: expected.text,
    ...tail,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Judges every claim against what the step read. A failure while judging
 * one claim makes that claim `unjudged` with the failure as its reason,
 * and the other claims are still judged. */
export async function evaluateClaims(claims: readonly Claim[], inputs: ClaimInputs): Promise<readonly JudgedClaim[]> {
  const judged: JudgedClaim[] = [];
  for (const claim of claims) {
    const actual = topLevelSide(claim.actual, inputs);
    const rawActual = "value" in actual ? actual.value : undefined;
    try {
      const record = isEachClaim(claim) ? await judgeEach(claim, actual, inputs) : await judgeComparison(claim, actual, inputs);
      judged.push({ record, rawActual, fromKey: actual.fromKey });
    } catch (error) {
      judged.push({ record: notJudged(claim, inputs, "unjudged", `nukadoko could not judge this claim: ${messageOf(error)}`), rawActual, fromKey: actual.fromKey });
    }
  }
  return judged;
}

/** Each claim's record when the step read no values: what each side would
 * have been named, nothing compared. */
export function unobservedClaims(claims: readonly Claim[], inputs: ClaimInputs): readonly JudgedClaim[] {
  return claims.map((claim): JudgedClaim => ({
    record: notJudged(claim, { ...inputs, observation: undefined }, "unobserved", undefined),
    rawActual: undefined,
    fromKey: inputs.fromKeys.has(pathSegments(claim.actual)?.[0] ?? "") ? (pathSegments(claim.actual)?.[0] ?? null) : null,
  }));
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
  holds: (value: unknown) => Promise<boolean>,
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
    consecutive = last.ok && (await holds(last.value)) ? consecutive + 1 : 0;
    if (consecutive >= 2) break;
    if (consecutive === 0 && clock.now() >= deadline) break;
    await clock.sleep(POLL_INTERVAL_MS);
  }
  return { last, attempts };
}
