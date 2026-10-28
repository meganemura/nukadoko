import type {
  ClaimCompare,
  ClaimComparisonRecord,
  ClaimEachRecord,
  ClaimItemDeclaration,
  ClaimItemRecord,
  ClaimReading,
  ClaimReadingValue,
  ClaimView,
} from "../record/types.js";
import {
  isEachClaim,
  literalStatedByAll,
  pathSegments,
  placeAt,
  placesOverlap,
  placeViewed,
  samePlace,
  type Claim,
  type ClaimLiteral,
  type ClaimPlace,
  type EachClaim,
  type ItemClaim,
} from "./claims.js";
import { readAt, snapshot, type Read, type Refusal } from "./snapshot.js";

// Responsibility: judging a claim step's claims against the values it read
// (docs/spec.md "Claims"). The runner takes a snapshot of every value a
// claim names where the value comes from (src/step/snapshot.ts) and hands
// in readers over those snapshots, with a way to test a regular expression
// that it can stop; what comes back is the record of each claim with the
// raw actual value beside it, so the runner can look for the channel it
// was measured on. Every function here is pure except for the pattern
// tester it is given. The poll loop is here too, with its clock and its
// reader injected, so the two-consecutive-holds rule is tested without a
// page.
//
// A claim reads snapshots only, never a value step code still holds, so
// what was compared and what the record shows are one value. A value a
// snapshot refuses (not plain JSON, a Proxy, nested too deep) is not
// judged: the claim is `unjudged` and names the part and what it is.

/** The JSON type a compare sees. `undefined` never reaches a compare: an
 * undefined side breaks first, naming its path. */
export type JsonType = "null" | "array" | "object" | "string" | "number" | "boolean";

export function jsonType(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return type;
  return "object";
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
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
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (type === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(right, key) || !deepEqual(left[key], right[key])) return false;
    }
    return true;
  }
  return false;
}

/** The value after `view`, or why the view could not apply. A view reads a
 * snapshot, and what it makes of one is a snapshot too: the JSON a text
 * parses to is held to the same depth limit. */
export function applyView(view: ClaimView | undefined, value: unknown): { readonly value: unknown } | { readonly reason: string } | { readonly refused: Refusal } {
  if (view === undefined) return { value };
  if (typeof value !== "string") return { reason: `view ${view} reads a string, and the value is ${typeof value === "object" ? article(jsonType(value)) : article(typeof value)}` };
  switch (view) {
    case "text":
      return { value: value.trimEnd() };
    case "lines": {
      const text = value.trimEnd();
      return { value: text === "" ? [] : text.split(/\r?\n/) };
    }
    case "json": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value) as unknown;
      } catch (error) {
        return { reason: `view json could not parse the value: ${error instanceof Error ? error.message : String(error)}` };
      }
      return snapshot(parsed);
    }
  }
}

/** What testing a regular expression found: whether it matches the text
 * and whether it matches the empty string, why it could not be tested (it
 * does not build), or that it was stopped when its time ran out. */
export type PatternOutcome =
  | { readonly holds: boolean; readonly matchesEmpty: boolean }
  | { readonly reason: string }
  | { readonly stopped: string };

/** Tests `pattern` against `text`, giving it at most `timeoutMs`;
 * `limit` says in a reason what that time is. The runner gives one that
 * runs where it can be stopped, since a pattern that backtracks can run for
 * longer than the step may. It throws only when it could not test at all. */
export type PatternTester = (pattern: string, text: string, timeoutMs: number, limit: string) => Promise<PatternOutcome>;

/** The time one judging may take, shared by every claim and item it
 * judges, so a slow claim takes its time from the claims after it rather
 * than each claim getting the whole of it. */
export interface JudgingBudget {
  /** The milliseconds judging may still take; 0 or less once spent. */
  readonly left: () => number;
  /** Marks the budget spent: a pattern ran until it was stopped. */
  readonly spend: () => void;
  /** What the budget is, as a reason names it: `the step's deadline`. */
  readonly limit: string;
}

/** A budget that ends at `endsAt` on `now`'s clock. Pure apart from
 * reading the clock. */
export function judgingBudget(endsAt: number, limit: string, now: () => number = Date.now): JudgingBudget {
  let spent = false;
  return {
    left: () => (spent ? 0 : endsAt - now()),
    spend: () => {
      spent = true;
    },
    limit,
  };
}

/** Why a claim, or the rest of an `each`, was not judged once the
 * budget was spent. */
function budgetSpent(budget: JudgingBudget, notJudged: number, of: number, what: "claims" | "items"): string {
  return `${budget.limit} passed, so nukadoko stopped judging: ${notJudged} of ${of} ${what} were not judged`;
}

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
  testPattern: (pattern: string, text: string) => Promise<PatternOutcome>,
): Promise<{ readonly holds: boolean } | { readonly reason: string } | { readonly stopped: string }> {
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
    case "starts-with-text":
    case "ends-with-text":
    case "matches": {
      if (actualType !== "string" || expectedType !== "string") {
        return { reason: `${compare} reads two strings, and compares ${article(actualType)} with ${article(expectedType)}` };
      }
      const text = expected as string;
      if (compare !== "matches") {
        if (text.trim() === "") return { reason: `${compare} has an expected text of only whitespace or nothing, which almost every string holds` };
        const value = actual as string;
        return { holds: compare === "contains-text" ? value.includes(text) : compare === "starts-with-text" ? value.startsWith(text) : value.endsWith(text) };
      }
      if (text === "") return { reason: "matches has an empty expected value, which every string holds" };
      const tested = await testPattern(text, actual as string);
      if ("reason" in tested || "stopped" in tested) return tested;
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

// --- what a claim reads ---

/** The paths a step's claims read, as segments from each root: from the
 * args (`[key, ...path]`: a sentence key, a `from` path) and from what
 * `observe` returned. An `actual` path takes its `at` with it when no
 * `view` stands between them, so the place read is the value judged and
 * nothing beside it: `actual: "users.0.name"` and `actual: "users", at:
 * "0.name"` read one place. The runner takes a snapshot of each one where
 * its value comes from, and the claims read nothing else. Pure. */
export interface ClaimReads {
  /** Every args path a claim reads. */
  readonly args: readonly (readonly string[])[];
  readonly observed: readonly (readonly string[])[];
  /** The args paths a claim compares as one value: what the args schema's
   * output is compared with whole. */
  readonly argValues: readonly (readonly string[])[];
  /** The args paths an `each` reads item by item. */
  readonly argItems: readonly ArgItems[];
}

/** An array an `each` reads from the args, and the paths inside one item
 * that its `where` and item claims read. */
export interface ArgItems {
  readonly segments: readonly string[];
  readonly inside: readonly (readonly string[])[];
}

/** The segments a claim's `actual` reads: its path, then its `at` when
 * no `view` stands between them. `null` for a path that is not one. */
export function actualSegments(claim: Pick<Claim, "actual" | "view" | "at">): readonly string[] | null {
  const segments = pathSegments(claim.actual);
  if (segments === null) return null;
  return claim.view === undefined && claim.at !== undefined ? [...segments, ...claim.at.split(".")] : segments;
}

/** The segments inside one item that an item claim reads, on the same
 * terms: its path (none for the item itself), then its `at`. */
export function itemSegments(claim: ItemClaim): readonly string[] {
  const segments = claim.actual === undefined ? [] : (pathSegments(claim.actual) ?? [claim.actual]);
  return claim.view === undefined && claim.at !== undefined ? [...segments, ...claim.at.split(".")] : segments;
}

export function claimReads(claims: readonly Claim[], fromKeys: ReadonlySet<string>): ClaimReads {
  const args = new Map<string, readonly string[]>();
  const observed = new Map<string, readonly string[]>();
  const argValues = new Map<string, readonly string[]>();
  const argItems = new Map<string, { segments: readonly string[]; inside: Map<string, readonly string[]> }>();
  const add = (into: Map<string, readonly string[]>, segments: readonly string[] | null): void => {
    if (segments !== null) into.set(readKey(segments), segments);
  };
  const addExpected = (expected: ItemClaim["expected"]): void => {
    if (typeof expected === "string") add(args, [expected]);
    else if ("from" in expected) add(args, pathSegments(expected.from));
    else if ("observe" in expected) add(observed, pathSegments(expected.observe));
    if (typeof expected === "string") add(argValues, [expected]);
    else if ("from" in expected) add(argValues, pathSegments(expected.from));
  };
  for (const claim of claims) {
    const segments = actualSegments(claim);
    const fromArgs = segments !== null && fromKeys.has(segments[0]!);
    if (segments !== null) add(fromArgs ? args : observed, segments);
    if (!isEachClaim(claim)) {
      if (fromArgs) add(argValues, segments);
      addExpected(claim.expected);
      continue;
    }
    const items = [...(claim.each.where ?? []), ...claim.each.claims];
    if (fromArgs) {
      const entry = argItems.get(readKey(segments)) ?? { segments, inside: new Map<string, readonly string[]>() };
      for (const item of items) add(entry.inside, itemSegments(item));
      argItems.set(readKey(segments), entry);
    }
    for (const item of items) addExpected(item.expected);
  }
  return {
    args: [...args.values()],
    observed: [...observed.values()],
    argValues: [...argValues.values()],
    argItems: [...argItems.values()].map((entry) => ({ segments: entry.segments, inside: [...entry.inside.values()] })),
  };
}

/** One key per path, for a map of snapshots. */
export function readKey(segments: readonly string[]): string {
  return JSON.stringify(segments);
}

/** Reads one path's snapshot. */
export type Reader = (segments: readonly string[]) => Read;

/** The snapshot of each path inside `root`, taken now. A read that throws
 * (no plain value does, and a Proxy is refused before its traps run) is a
 * refusal with the error, so taking snapshots never throws. */
export function takeReads(root: unknown, paths: readonly (readonly string[])[]): ReadonlyMap<string, Read> {
  const reads = new Map<string, Read>();
  for (const segments of paths) {
    let read: Read;
    try {
      read = readAt(root, segments);
    } catch (error) {
      read = { refused: { at: [], problem: `could not be read: ${error instanceof Error ? error.message : String(error)}` } };
    }
    reads.set(readKey(segments), read);
  }
  return reads;
}

/** A reader over snapshots taken before. A path no snapshot was taken of
 * is a refusal: a claim never reads a live value. */
export function readerOf(reads: ReadonlyMap<string, Read>): Reader {
  return (segments) => reads.get(readKey(segments)) ?? { refused: { at: [], problem: "was not read when its value was taken" } };
}

/** A reader that takes each snapshot when it is asked, for a value no step
 * code holds any more (a test's literal, a value already copied). */
export function readerNow(root: unknown): Reader {
  return (segments) => readAt(root, segments);
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
  /** The args a claim names, as snapshots the runner took of the bound
   * args before the args schema ran: a sentence value after its parameter
   * type, and a `from` value, which is a fresh copy of the snapshot taken
   * of the producing step's result the moment it returned (the value its
   * record shows). Read by `[key, ...path]`. */
  readonly args: Reader;
  /** What `observe` returned, as snapshots taken the moment it returned.
   * `observe` itself received copies of its inputs, never the args. */
  readonly observed: Reader;
  /** Where the args schema's output differs from the snapshot at a place
   * a claim reads (`segments`, read as one value, or item by item for an
   * `each`), or `null`: a claim on such a value would judge something the
   * line or the earlier step did not give. */
  readonly schemaChanged: (segments: readonly string[], itemwise: boolean) => readonly string[] | null;
  readonly fromKeys: ReadonlySet<string>;
  /** The args keys `observe` received: every key but an expected one for
   * a step with `observe`, none for a step without it. */
  readonly observeReceived: readonly string[];
  /** Where an args key's value starts: `sentence:<key>` for a value the
   * line states, `from:<step>@<line>.<returns key>` for a value an earlier
   * step returned. */
  readonly argSide: (key: string) => ArgSide;
  /** The text the line states an args key as: a capture's text, the
   * docstring, or the table; `null` for a key the line does not fill. */
  readonly sentenceText: (key: string) => string | null;
  /** Why a claim cannot compare with an args key, when the matched
   * pattern fills it with a parameter type that has a transformer; `null`
   * (or absent) when it does not. `nuka check` reports such a pattern
   * (`claim-expected-transformed`); the run leaves the claim unjudged, so
   * a run under `--no-check` agrees with the check. */
  readonly transformed?: (key: string) => string | null;
  readonly patterns: readonly string[];
  readonly testPattern: PatternTester;
  readonly budget: JudgingBudget;
}

/** Where an expected value was read, when a step record can hold it: the
 * args key a `from` value filled (the record of the step that returned
 * it), or `observe` (the claim step's own record). `null` for a value the
 * sentence states or a literal, which no channel holds. */
export type ExpectedOrigin = { readonly fromKey: string } | "observe" | null;

/** One claim as judged, with the raw actual value (the place `actual`
 * reads, before `view` and the `at` after a view) the runner compares with each recorded channel, the args key it
 * was read from (`null` for a value `observe` returned), and where each
 * expected value the record declares was read: a comparison's one, or an
 * `each`'s `where` declarations followed by its claims. */
export interface JudgedClaim {
  readonly record: ClaimComparisonRecord | ClaimEachRecord;
  readonly rawActual: unknown;
  readonly fromKey: string | null;
  readonly expectedOrigins: readonly ExpectedOrigin[];
}

/** Where `claim`'s expected value is read, for `expected_measured`. Pure. */
export function expectedOriginOf(claim: ItemClaim, fromKeys: ReadonlySet<string>): ExpectedOrigin {
  const expected = claim.expected;
  if (typeof expected === "string") return fromKeys.has(expected) ? { fromKey: expected } : null;
  if ("from" in expected) {
    const head = (pathSegments(expected.from) ?? [expected.from])[0]!;
    return fromKeys.has(head) ? { fromKey: head } : null;
  }
  return "observe" in expected ? "observe" : null;
}

/** The origins of every expected value `claim` declares, in record order. */
function expectedOriginsOf(claim: Claim, fromKeys: ReadonlySet<string>): readonly ExpectedOrigin[] {
  const entries = isEachClaim(claim) ? [...(claim.each.where ?? []), ...claim.each.claims] : [claim];
  return entries.map((entry) => expectedOriginOf(entry, fromKeys));
}

/** A value read at a place, or why there is none: a reason that breaks the
 * claim (nothing there, a view that could not apply), or one that leaves
 * it unjudged (a value no snapshot could take). */
type Side =
  | { readonly place: ClaimPlace; readonly value: unknown }
  | { readonly place: ClaimPlace; readonly broken: string }
  | { readonly place: ClaimPlace; readonly unjudged: string };

function argPlace(key: string, inputs: ClaimInputs): ClaimPlace {
  const side = inputs.argSide(key);
  return { origin: side.origin, segments: side.segments, label: side.label, open: false };
}

const OBSERVE_PLACE: ClaimPlace = { origin: "observe", segments: [], label: "observe:", open: false };

function nameOf(place: ClaimPlace): string {
  return place.label.endsWith(":") ? "the value observe returned" : place.label;
}

/** Why a refused value is not judged, naming where it sits. A value nested
 * past the limit is plain JSON, so its reason does not say otherwise. */
function refusalReason(place: ClaimPlace, refusal: Refusal): string {
  const name = nameOf(placeAt(place, refusal.at.join(".")));
  if (refusal.limit !== undefined) {
    return `${name} ${refusal.problem}, so the claim was not judged: the record keeps no value nested that deep`;
  }
  return `${name} ${refusal.problem}, which is not plain JSON, so the claim was not judged: a claim judges a plain JSON copy of the value it reads`;
}

/** The side a read found, with `base` the place its root sits at and
 * `skip` the read's segments already in `base` (an args key). */
function sideOf(read: Read, base: ClaimPlace, rest: readonly string[], skip: number, name: (place: ClaimPlace) => string = nameOf): Side {
  const place = placeAt(base, rest.join("."));
  if ("refused" in read) return { place, unjudged: refusalReason(base, { ...read.refused, at: read.refused.at.slice(skip) }) };
  if ("missing" in read) return { place, broken: `${name(place)} is undefined` };
  return { place, value: read.value };
}

function readArgSide(segments: readonly string[], inputs: ClaimInputs, name?: (place: ClaimPlace) => string): Side {
  const [head, ...rest] = segments;
  return sideOf(inputs.args(segments), argPlace(head!, inputs), rest, 1, name);
}

/** The top-level side a claim's `actual` names, read at its path and,
 * with no `view`, at its `at` too (`actualSegments`), so the snapshot is
 * of the value judged alone; `atRead` says the `at` was read here. The
 * side's place is the path's, and `shaped` adds the `at`. */
function topLevelSide(claim: Claim, inputs: ClaimInputs): Side & { readonly fromKey: string | null; readonly atRead: boolean } {
  const path = pathSegments(claim.actual) ?? [claim.actual];
  const segments = actualSegments(claim) ?? path;
  const atRead = segments.length > path.length;
  const fromKey = inputs.fromKeys.has(path[0]!) ? path[0]! : null;
  const read = fromKey === null ? inputs.observed(segments) : inputs.args(segments);
  const base = fromKey === null ? OBSERVE_PLACE : argPlace(fromKey, inputs);
  const skip = fromKey === null ? 0 : 1;
  const rest = path.slice(skip);
  if (atRead && "missing" in read && read.missing >= path.length) {
    const place = placeAt(base, rest.join("."));
    return { place, broken: `${place.label} has nothing at ${claim.at!}`, fromKey, atRead };
  }
  return { ...sideOf(read, base, rest, skip), fromKey, atRead };
}

/** A side through `view` and then `at`; `atRead` when the side was read
 * at its `at` already. */
function shaped(side: Side, view: ClaimView | undefined, at: string | undefined, atRead = false): Side {
  const viewedPlace = placeViewed(side.place, view);
  const place = placeAt(viewedPlace, at);
  if (!("value" in side)) return "broken" in side ? { place, broken: side.broken } : { place, unjudged: side.unjudged };
  if (atRead) return { place, value: side.value };
  const viewed = applyView(view, side.value);
  if ("reason" in viewed) return { place, broken: viewed.reason };
  if ("refused" in viewed) return { place, unjudged: refusalReason(viewedPlace, viewed.refused) };
  if (at === undefined) return { place: viewedPlace, value: viewed.value };
  const read = readAt(viewed.value, at.split("."));
  if ("value" in read) return { place, value: read.value };
  return { place, broken: `${viewedPlace.label} has nothing at ${at}` };
}

/** An expected value, its place, and the text the sentence states it as. */
type ExpectedSide = Side & { readonly text: string | null; readonly fromObserve: boolean; readonly segments: readonly string[] | null };

const expectedName = (place: ClaimPlace): string => `the expected value ${place.label}`;

function expectedSide(claim: ItemClaim, inputs: ClaimInputs): ExpectedSide {
  const expected = claim.expected;
  if (typeof expected === "string") {
    const transformed = inputs.transformed?.(expected) ?? null;
    if (transformed !== null) {
      return { place: argPlace(expected, inputs), unjudged: transformed, text: inputs.sentenceText(expected), fromObserve: false, segments: [expected] };
    }
    const side = shaped(readArgSide([expected], inputs, expectedName), claim.expected_view, undefined);
    return { ...side, text: inputs.sentenceText(expected), fromObserve: false, segments: [expected] };
  }
  if ("from" in expected) {
    const segments = pathSegments(expected.from) ?? [expected.from];
    return { ...readArgSide(segments, inputs, expectedName), text: null, fromObserve: false, segments };
  }
  if ("observe" in expected) {
    const segments = pathSegments(expected.observe) ?? [expected.observe];
    return { ...sideOf(inputs.observed(segments), OBSERVE_PLACE, segments, 0, expectedName), text: null, fromObserve: true, segments: null };
  }
  const words = literalStatedByAll(inputs.patterns, expected.literal) ?? "unstated";
  const place: ClaimPlace = { origin: "literal", segments: [], label: `literal:${words}`, open: false };
  return { place, value: literalValue(expected.literal), text: words, fromObserve: false, segments: null };
}

function literalValue(literal: ClaimLiteral): unknown {
  return Array.isArray(literal) ? [] : literal;
}

/** What stops a comparison before any compare runs: a reason that breaks
 * it, one that leaves it unjudged, or `null`. */
type Stop = { readonly broken: string } | { readonly unjudged: string } | null;

/** A claim on a value the args schema changed is not judged: nothing is
 * known of the criterion from it, since the claim would read neither what
 * the line or the earlier step gave nor what the step received. */
function schemaChange(segments: readonly string[] | null, inputs: ClaimInputs, itemwise = false): Stop {
  const changed = segments === null ? null : inputs.schemaChanged(segments, itemwise);
  if (changed === null) return null;
  const [key, ...rest] = changed;
  const where = rest.length === 0 ? `args.${key!}` : `args.${key!} at ${rest.join(".")}`;
  return { unjudged: `the args schema changed ${where} from the value nukadoko read before it ran, so the claim was not judged` };
}

function stopOf(side: Side): Stop {
  if ("broken" in side) return { broken: side.broken };
  if ("unjudged" in side) return { unjudged: side.unjudged };
  return null;
}

/** Whether `observe` received the value `place` reads, one that holds
 * it, or one inside it, where `place` is the side of a claim that
 * `observe` does not answer: an expected `{ from }`, or an actual `from`
 * value compared with `{ observe }`. Then `observe` could return the
 * value the claim compares it with, and the claim holds whatever the
 * behaviour is. `observe` never receives an expected key itself, so on
 * that side only a second key filled from the same earlier result can
 * carry the value; an actual key it does receive. `nuka check` refuses
 * the step for either (`claim-compares-itself`); the run breaks the claim
 * too, so a run under `--no-check` and `nuka do --use` judge it the same
 * way. `reads` says, in the reason, which side reads `place`. */
function observeReceived(place: ClaimPlace, inputs: ClaimInputs, reads: string): Stop {
  for (const key of inputs.observeReceived) {
    const input = argPlace(key, inputs);
    if (!placesOverlap(input, place)) continue;
    return {
      broken: `observe received args.${key}, which is ${input.label}, and ${reads} ${place.label}, so observe could return the value the claim compares it with`,
    };
  }
  return null;
}

function precondition(actual: Side, actualSegments: readonly string[] | null, expected: ExpectedSide, inputs: ClaimInputs): Stop {
  const stop = schemaChange(actualSegments, inputs) ?? schemaChange(expected.segments, inputs) ?? stopOf(actual) ?? stopOf(expected);
  if (stop !== null) return stop;
  if (samePlace(actual.place, expected.place)) {
    return { broken: `both sides read ${actual.place.label}, so the claim compares a value with itself` };
  }
  const received =
    observeReceived(expected.place, inputs, "the expected value reads") ??
    (expected.fromObserve ? observeReceived(actual.place, inputs, "the actual value reads") : null);
  if (received !== null) return received;
  if (expected.fromObserve && "value" in expected && typeof expected.value === "boolean") {
    return { broken: `the expected value ${expected.place.label} is a boolean observe computed, which is a judgment made in code: return the thing measured and let the claim compare it` };
  }
  return null;
}

function declarationOf(claim: ItemClaim, expected: ExpectedSide | null): ClaimItemDeclaration {
  const place = expected?.place ?? expectedPlace(claim, null);
  return {
    ...(claim.actual === undefined ? {} : { actual: claim.actual }),
    ...(claim.view === undefined ? {} : { view: claim.view }),
    ...(claim.at === undefined ? {} : { at: claim.at }),
    compare: claim.compare,
    ...(expected !== null && "value" in expected ? { expected: expected.value } : {}),
    expected_from: place.label,
    ...(claim.expected_view === undefined ? {} : { expected_view: claim.expected_view }),
    expected_text: expected?.text ?? null,
  };
}

async function judgeComparison(
  claim: ItemClaim,
  rawActual: Side,
  readSegments: readonly string[] | null,
  inputs: ClaimInputs,
  atRead = false,
): Promise<ClaimComparisonRecord> {
  const expected = expectedSide(claim, inputs);
  const actual = shaped(rawActual, claim.view, claim.at, atRead);
  // Field order is the order a reader reads a claim in: what was measured,
  // how, and what it was compared with.
  const base = {
    ...("value" in actual ? { actual: actual.value } : {}),
    actual_from: actual.place.label,
    ...(claim.view === undefined ? {} : { view: claim.view }),
    ...(claim.at === undefined ? {} : { at: claim.at }),
    compare: claim.compare,
    ...("value" in expected ? { expected: expected.value } : {}),
    expected_from: expected.place.label,
    ...(claim.expected_view === undefined ? {} : { expected_view: claim.expected_view }),
    expected_text: expected.text,
  };
  const stop = precondition(actual, readSegments, expected, inputs);
  if (stop !== null) return "broken" in stop ? { ...base, outcome: "broken", reason: stop.broken } : { ...base, outcome: "unjudged", reason: stop.unjudged };
  const result = await compareValues(claim.compare, (actual as { value: unknown }).value, (expected as { value: unknown }).value, (pattern, text) =>
    testWithinBudget(pattern, text, inputs),
  );
  if ("stopped" in result) return { ...base, outcome: "unjudged", reason: result.stopped };
  if ("reason" in result) return { ...base, outcome: "broken", reason: result.reason };
  return { ...base, outcome: result.holds ? "held" : "broken" };
}

/** Tests a pattern with the time left of the budget, and never with none:
 * a pattern stopped when its time ran out spends the budget, so no later
 * item starts a worker only to stop it again. */
async function testWithinBudget(pattern: string, text: string, inputs: ClaimInputs): Promise<PatternOutcome> {
  const left = inputs.budget.left();
  if (left <= 0) return { stopped: `${inputs.budget.limit} had passed, so nukadoko did not test the pattern` };
  const tested = await inputs.testPattern(pattern, text, left, `the time left of ${inputs.budget.limit}`);
  if ("stopped" in tested) inputs.budget.spend();
  return tested;
}

/** At most this many items of one `each` are kept on the record. */
export const EACH_RESULTS_CAP = 20;

/** The side an item claim reads: the item, or a path inside it. The item
 * is part of a snapshot, so a read inside it finds a value or nothing. */
function itemSide(item: unknown, itemPlace: ClaimPlace, claim: ItemClaim): Side {
  const segments = claim.actual === undefined ? [] : (pathSegments(claim.actual) ?? [claim.actual]);
  return sideOf(readAt(item, segments), itemPlace, segments, 0);
}

function itemOutcome(records: readonly ClaimComparisonRecord[]): "held" | "broken" | "unjudged" {
  if (records.some((record) => record.outcome === "broken")) return "broken";
  return records.some((record) => record.outcome === "unjudged") ? "unjudged" : "held";
}

async function judgeEach(claim: EachClaim, rawActual: Side, readSegments: readonly string[] | null, inputs: ClaimInputs, atRead = false): Promise<ClaimEachRecord> {
  const actual = shaped(rawActual, claim.view, claim.at, atRead);
  const where = claim.each.where ?? [];
  const declared = {
    ...(where.length === 0 ? {} : { where: where.map((entry) => declarationOf(entry, expectedSide(entry, inputs))) }),
    claims: claim.each.claims.map((entry) => declarationOf(entry, expectedSide(entry, inputs))),
  };
  const base = {
    actual_from: actual.place.label,
    ...(claim.view === undefined ? {} : { view: claim.view }),
    ...(claim.at === undefined ? {} : { at: claim.at }),
  };
  // Once the array was read, the record counts its items, whatever ended
  // the claim.
  const itemCount = "value" in actual && Array.isArray(actual.value) ? actual.value.length : 0;
  const ended = (outcome: "broken" | "unjudged", reason: string, results: readonly ClaimItemRecord[] = []): ClaimEachRecord => ({
    ...base,
    each: { ...declared, items: itemCount, selected: 0, results },
    outcome,
    reason,
  });
  const stop = schemaChange(readSegments, inputs, true) ?? stopOf(actual) ?? eachObserveReceived(claim, actual.place, inputs);
  if (stop !== null) return "broken" in stop ? ended("broken", stop.broken) : ended("unjudged", stop.unjudged);
  const implied = whereImplication(claim, inputs);
  if (implied !== null) return ended("broken", implied);
  const value = (actual as { value: unknown }).value;
  if (!Array.isArray(value)) return ended("broken", `each reads an array, and the value is ${article(jsonType(value))}`);
  const items: unknown[] = value;
  if (items.length === 0) return ended("broken", "the array is empty, and a claim on every item of nothing measures nothing");
  const judged: ClaimItemRecord[] = [];
  // The record of an each the budget ran out on, before item `next`. An
  // item whose pattern was stopped counts as not judged too, and an item
  // that already broke decides the claim; otherwise nothing is known about
  // the items left.
  const stopped = (next: number): ClaimEachRecord => {
    const selectedSoFar = judged.filter((entry) => entry.selected);
    const broke = selectedSoFar.some((entry) => entry.selected && entry.outcome === "broken");
    const unjudged = selectedSoFar.filter((entry) => entry.selected && entry.outcome === "unjudged").length;
    const kept = keptItems(judged);
    return {
      ...base,
      each: { ...declared, items: items.length, selected: selectedSoFar.length, results: kept, ...(judged.length > kept.length ? { results_truncated: judged.length } : {}) },
      outcome: broke ? "broken" : "unjudged",
      reason: budgetSpent(inputs.budget, items.length - next + unjudged, items.length, "items"),
    };
  };
  for (let index = 0; index < items.length; index += 1) {
    if (inputs.budget.left() <= 0) return stopped(index);
    const itemPlace = placeAt(actual.place, String(index));
    const whereRecords: ClaimComparisonRecord[] = [];
    for (const entry of where) {
      whereRecords.push(await judgeComparison(entry, itemSide(items[index], itemPlace, entry), null, inputs));
    }
    // A where claim that could not compare at all (an undefined value, two
    // JSON types) says nothing about whether the item belongs, so leaving
    // the item out would turn "every item" into "the items that happen to
    // compare".
    const unjudgeable = whereRecords.find((record) => record.reason !== undefined);
    if (unjudgeable !== undefined) {
      const outcome = unjudgeable.outcome === "unjudged" ? "unjudged" : "broken";
      return ended(outcome, `where could not ${outcome === "unjudged" ? "judge" : "compare"} item ${index}: ${unjudgeable.reason}`, [{ index, selected: false, where: whereRecords }]);
    }
    if (!whereRecords.every((record) => record.outcome === "held")) {
      judged.push({ index, selected: false, where: whereRecords });
      continue;
    }
    const claims: ClaimComparisonRecord[] = [];
    for (const entry of claim.each.claims) {
      claims.push(await judgeComparison(entry, itemSide(items[index], itemPlace, entry), null, inputs));
    }
    judged.push({
      index,
      selected: true,
      ...(whereRecords.length === 0 ? {} : { where: whereRecords }),
      outcome: itemOutcome(claims),
      claims,
    });
  }
  if (inputs.budget.left() <= 0 && judged.some((entry) => entry.selected && entry.outcome === "unjudged")) return stopped(items.length);
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
  const outcomes = selected.map((entry) => (entry.selected ? entry.outcome : "held"));
  return {
    ...base,
    each: { ...declared, items: items.length, selected: selected.length, results: kept, ...truncated },
    outcome: outcomes.includes("broken") ? "broken" : outcomes.includes("unjudged") ? "unjudged" : "held",
  };
}

/** Whether every value a `where` clause selects holds an item claim on
 * the same value, whatever the value is: the same order direction with a
 * bound at least as strict (`greater-than 10` then `at-least 5`), or
 * `not-equal` against the same value. Then the claim holds on every
 * item `where` selects, and "every item" measures nothing. A pair it does
 * not imply (`greater-than 10` then `at-most 100`) can break on the data.
 * Pure. */
export function whereImplies(where: ClaimCompare, whereValue: unknown, claim: ClaimCompare, claimValue: unknown): boolean {
  if (where === "not-equal") return claim === "not-equal" && jsonType(whereValue) === jsonType(claimValue) && deepEqual(whereValue, claimValue);
  if (typeof whereValue !== "number" || typeof claimValue !== "number") return false;
  const up = (compare: ClaimCompare): boolean => compare === "greater-than" || compare === "at-least";
  const down = (compare: ClaimCompare): boolean => compare === "less-than" || compare === "at-most";
  const strict = (compare: ClaimCompare): boolean => compare === "greater-than" || compare === "less-than";
  if (up(where) && up(claim)) return !strict(where) && strict(claim) ? whereValue > claimValue : whereValue >= claimValue;
  if (down(where) && down(claim)) return !strict(where) && strict(claim) ? whereValue < claimValue : whereValue <= claimValue;
  return false;
}

/** The first pair of a `where` clause and an item claim that read one
 * value (one path and one view) where the clause implies the claim
 * (`whereImplies`), as the reason that breaks the `each`; `null` when
 * there is none. `defineStep` already refuses an overlapping clause whose
 * compare decides the value; this is the rest, which only the expected
 * values in hand can decide. */
function whereImplication(claim: EachClaim, inputs: ClaimInputs): string | null {
  const expectedValue = (entry: ItemClaim): { readonly value: unknown } | null => {
    const side = expectedSide(entry, inputs);
    return "value" in side ? { value: side.value } : null;
  };
  for (const [whereIndex, where] of (claim.each.where ?? []).entries()) {
    if (where.compare !== "not-equal" && !ORDER_COMPARES.has(where.compare)) continue;
    const place = itemSegments(where);
    for (const [claimIndex, entry] of claim.each.claims.entries()) {
      const other = itemSegments(entry);
      if (where.view !== entry.view || other.length !== place.length || !other.every((segment, index) => segment === place[index])) continue;
      const whereValue = expectedValue(where);
      const claimValue = expectedValue(entry);
      if (whereValue === null || claimValue === null || !whereImplies(where.compare, whereValue.value, entry.compare, claimValue.value)) continue;
      const what = `${place.length === 0 ? "value" : place.join(".")}${where.view === undefined ? "" : ` as ${where.view}`}`;
      return (
        `each.where[${whereIndex}] selects the items whose ${what} is ${where.compare} ${JSON.stringify(whereValue.value)}, ` +
        `and every such item holds each.claims[${claimIndex}], ${entry.compare} ${JSON.stringify(claimValue.value)}, whatever the data, so the claim measures nothing`
      );
    }
  }
  return null;
}

const ORDER_COMPARES: ReadonlySet<ClaimCompare> = new Set(["greater-than", "at-least", "less-than", "at-most"]);

/** `observeReceived` for every declaration of an `each`, before any item:
 * it does not depend on an item, and an empty array would hide it. A
 * declaration whose expected value comes from `observe` reads inside
 * every item of `array`, so `observe` must not receive the array's
 * place either. */
function eachObserveReceived(claim: EachClaim, array: ClaimPlace, inputs: ClaimInputs): Stop {
  const entries: readonly (readonly [string, ItemClaim])[] = [
    ...(claim.each.where ?? []).map((entry, index) => [`each.where[${index}]`, entry] as const),
    ...claim.each.claims.map((entry, index) => [`each.claims[${index}]`, entry] as const),
  ];
  for (const [label, entry] of entries) {
    const transformed = typeof entry.expected === "string" ? (inputs.transformed?.(entry.expected) ?? null) : null;
    if (transformed !== null) return { unjudged: `${label}: ${transformed}` };
    const stop =
      observeReceived(expectedPlace(entry, inputs), inputs, `${label}'s expected value reads`) ??
      (typeof entry.expected === "object" && "observe" in entry.expected ? observeReceived(array, inputs, `${label} reads each item of`) : null);
    if (stop !== null) return stop;
  }
  return null;
}

/** The item results the record keeps: the broken ones first, then the
 * unjudged ones, then the ones `where` left out, then the ones that held,
 * at most `EACH_RESULTS_CAP`, in index order. */
function keptItems(judged: readonly ClaimItemRecord[]): ClaimItemRecord[] {
  const rank = (entry: ClaimItemRecord): number => (!entry.selected ? 2 : entry.outcome === "broken" ? 0 : entry.outcome === "unjudged" ? 1 : 3);
  return [...judged]
    .sort((a, b) => rank(a) - rank(b) || a.index - b.index)
    .slice(0, EACH_RESULTS_CAP)
    .sort((a, b) => a.index - b.index);
}

// --- labels alone, for a claim nothing was compared for ---

function actualPlace(claim: Claim, inputs: ClaimInputs): ClaimPlace {
  const segments = pathSegments(claim.actual) ?? [claim.actual];
  const base = inputs.fromKeys.has(segments[0]!) ? placeAt(argPlace(segments[0]!, inputs), segments.slice(1).join(".")) : placeAt(OBSERVE_PLACE, claim.actual);
  return placeAt(placeViewed(base, claim.view), claim.at);
}

function expectedPlace(claim: ItemClaim, inputs: ClaimInputs | null): ClaimPlace {
  const expected = claim.expected;
  if (typeof expected === "string") {
    const base: ClaimPlace = inputs === null ? { origin: `sentence:${expected}`, segments: [], label: `sentence:${expected}`, open: false } : argPlace(expected, inputs);
    return placeViewed(base, claim.expected_view);
  }
  if ("from" in expected) {
    const segments = pathSegments(expected.from) ?? [expected.from];
    if (inputs === null) return { origin: "from", segments, label: `from:${expected.from}`, open: false };
    return placeAt(argPlace(segments[0]!, inputs), segments.slice(1).join("."));
  }
  if ("observe" in expected) return placeAt(OBSERVE_PLACE, expected.observe);
  const words = inputs === null ? "unstated" : (literalStatedByAll(inputs.patterns, expected.literal) ?? "unstated");
  return { origin: "literal", segments: [], label: `literal:${words}`, open: false };
}

function expectedTextOf(claim: ItemClaim, inputs: ClaimInputs): string | null {
  const expected = claim.expected;
  if (typeof expected === "string") return inputs.sentenceText(expected);
  if ("literal" in expected) return literalStatedByAll(inputs.patterns, expected.literal) ?? "unstated";
  return null;
}

/** Each claim's labels when nothing was compared: what each side would
 * have been named, with `outcome` and, for an unjudged claim, why. It
 * reads no value, so it cannot fail. */
function notJudged(claim: Claim, inputs: ClaimInputs, outcome: "unobserved" | "unjudged" | "broken", reason: string | undefined): ClaimComparisonRecord | ClaimEachRecord {
  const tail = { outcome, ...(reason === undefined ? {} : { reason }) };
  const base = {
    actual_from: actualPlace(claim, inputs).label,
    ...(claim.view === undefined ? {} : { view: claim.view }),
    ...(claim.at === undefined ? {} : { at: claim.at }),
  };
  const declaration = (entry: ItemClaim): ClaimItemDeclaration => ({
    ...declarationOf(entry, null),
    expected_from: expectedPlace(entry, inputs).label,
    expected_text: expectedTextOf(entry, inputs),
  });
  if (isEachClaim(claim)) {
    const where = claim.each.where ?? [];
    return {
      ...base,
      each: {
        ...(where.length === 0 ? {} : { where: where.map(declaration) }),
        claims: claim.each.claims.map(declaration),
        items: 0,
        selected: 0,
        results: [],
      },
      ...tail,
    };
  }
  return {
    ...base,
    compare: claim.compare,
    expected_from: expectedPlace(claim, inputs).label,
    ...(claim.expected_view === undefined ? {} : { expected_view: claim.expected_view }),
    expected_text: expectedTextOf(claim, inputs),
    ...tail,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fromKeyOf(claim: Claim, fromKeys: ReadonlySet<string>): string | null {
  const head = pathSegments(claim.actual)?.[0];
  return head !== undefined && fromKeys.has(head) ? head : null;
}

/** Judges every claim against what the step read. A failure while judging
 * one claim makes that claim `unjudged` with the failure as its reason,
 * and the other claims are still judged. */
export async function evaluateClaims(claims: readonly Claim[], inputs: ClaimInputs): Promise<readonly JudgedClaim[]> {
  const judged: JudgedClaim[] = [];
  // Where the budget ran out: every claim from there on says the same count.
  let stoppedAt: number | null = null;
  for (const [index, claim] of claims.entries()) {
    const fromKey = fromKeyOf(claim, inputs.fromKeys);
    const expectedOrigins = expectedOriginsOf(claim, inputs.fromKeys);
    if (stoppedAt === null && inputs.budget.left() <= 0) stoppedAt = index;
    if (stoppedAt !== null) {
      const reason = budgetSpent(inputs.budget, claims.length - stoppedAt, claims.length, "claims");
      judged.push({ record: notJudged(claim, inputs, "unjudged", reason), rawActual: undefined, fromKey, expectedOrigins });
      continue;
    }
    let rawActual: unknown;
    try {
      const actual = topLevelSide(claim, inputs);
      rawActual = "value" in actual ? actual.value : undefined;
      const segments = actual.fromKey === null ? null : actualSegments(claim);
      const record = isEachClaim(claim)
        ? await judgeEach(claim, actual, segments, inputs, actual.atRead)
        : await judgeComparison(claim, actual, segments, inputs, actual.atRead);
      judged.push({ record, rawActual, fromKey, expectedOrigins });
    } catch (error) {
      const reason = `nukadoko could not judge this claim: ${messageOf(error)}`;
      judged.push({ record: notJudged(claim, inputs, "unjudged", reason), rawActual, fromKey, expectedOrigins });
    }
  }
  return judged;
}

/** Each claim's record when the step ended for `reason` before anything
 * was read: `unjudged` when nukadoko could not judge the claims, `broken`
 * when the step as declared cannot judge what its line states. What each
 * side would have been named, nothing compared. */
export function claimsEndedEarly(claims: readonly Claim[], inputs: ClaimInputs, outcome: "unjudged" | "broken", reason: string): readonly JudgedClaim[] {
  return claims.map((claim): JudgedClaim => ({
    record: notJudged(claim, inputs, outcome, reason),
    rawActual: undefined,
    fromKey: fromKeyOf(claim, inputs.fromKeys),
    expectedOrigins: expectedOriginsOf(claim, inputs.fromKeys),
  }));
}

/** Each claim's record when the step read no values: what each side would
 * have been named, nothing compared. */
export function unobservedClaims(claims: readonly Claim[], inputs: ClaimInputs): readonly JudgedClaim[] {
  return claims.map((claim): JudgedClaim => ({
    record: notJudged(claim, inputs, "unobserved", undefined),
    rawActual: undefined,
    fromKey: fromKeyOf(claim, inputs.fromKeys),
    expectedOrigins: expectedOriginsOf(claim, inputs.fromKeys),
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

// --- the readings of a polled claim step ---
//
// `poll` reads until every claim holds, so the number of readings tells
// `observe` whether a reading held: a step can offer candidates until one
// holds. No rule in code can tell that from a value that settles, so the
// record keeps what each reading read, and a value that walks toward the
// expected one is there to see. A long poll keeps the readings where the
// value changed, not the first and last few: a step that pads its
// candidates with readings that repeat would otherwise push them out. The
// walk can be on either side: when an expected value comes from `observe`
// too, each reading keeps both sides, since a constant actual value says
// nothing about an expected one that moved toward it.

/** How many readings the record keeps: every reading of a poll this
 * short, and of a longer one the first, the last, and the readings whose
 * value differs from the reading before (change points), the earliest
 * half and the latest half of them. */
export const CLAIM_READINGS_CAP = 40;
/** The longest value, as JSON, a reading keeps whole. */
export const CLAIM_READING_MAX_BYTES = 1024;

/** A claim's raw actual value as one reading keeps it. Pure. */
export function readingValue(raw: unknown, reason: string | undefined): ClaimReadingValue {
  if (raw === undefined) return { reason: reason ?? "no value" };
  let text: string;
  try {
    text = JSON.stringify(raw) ?? "null";
  } catch {
    return { reason: reason ?? "the value is not JSON" };
  }
  const bytes = new TextEncoder().encode(text).length;
  return bytes <= CLAIM_READING_MAX_BYTES ? { value: raw } : { json_start: text.slice(0, CLAIM_READING_MAX_BYTES), json_bytes: bytes };
}

/** The value `record` compared as expected: a comparison's `expected`,
 * or, for an `each`, every declaration's expected value under its label
 * (one with none left out). `undefined` when a comparison had none. */
function expectedOfRecord(record: ClaimComparisonRecord | ClaimEachRecord): unknown {
  if (!("each" in record)) return "expected" in record ? record.expected : undefined;
  const values: Record<string, unknown> = {};
  const add = (label: string, declarations: readonly ClaimItemDeclaration[] | undefined): void => {
    declarations?.forEach((declaration, index) => {
      if ("expected" in declaration) values[`each.${label}[${index}]`] = declaration.expected;
    });
  };
  add("where", record.each.where);
  add("claims", record.each.claims);
  return values;
}

/** A side's value in full, for comparing two readings. */
function fullValue(raw: unknown, reason: string | undefined): unknown {
  return raw === undefined ? { reason: reason ?? "no value" } : { value: raw };
}

/**
 * One reading as the record keeps it, from the claims judged on it, and
 * its content: whether it held and what each claim read, in full, so a
 * reading that differs from the one before only past the point where a
 * long value is cut is still a change point. `expecteds` is there when an
 * expected value comes from `observe`. Pure.
 */
export function readingOf(attempt: number, at: string, judged: readonly JudgedClaim[]): { readonly reading: ClaimReading; readonly content: string } {
  const held = judged.every((entry) => entry.record.outcome === "held");
  const both = judged.some((entry) => entry.expectedOrigins.includes("observe"));
  const expected = judged.map((entry) => expectedOfRecord(entry.record));
  const reading: ClaimReading = {
    attempt,
    at,
    held,
    actuals: judged.map((entry) => readingValue(entry.rawActual, entry.record.reason)),
    ...(both ? { expecteds: judged.map((entry, index) => readingValue(expected[index], entry.record.reason)) } : {}),
  };
  let content: string;
  try {
    content = JSON.stringify([
      held,
      judged.map((entry) => fullValue(entry.rawActual, entry.record.reason)),
      both ? judged.map((entry, index) => fullValue(expected[index], entry.record.reason)) : null,
      null,
    ]);
  } catch {
    // A value that is not JSON is kept as its reason, so the cut form is
    // all there is to compare.
    content = readingContent(reading);
  }
  return { reading, content };
}

/** A reading on which `observe` threw. Pure. */
export function failedReading(attempt: number, at: string, error: unknown): ClaimReading {
  const message = error instanceof Error ? error.message : String(error);
  return { attempt, at, held: false, error: message.split("\n")[0] ?? "" };
}

/** How many readings, and how many of the change points among them, the
 * record left out. */
export interface ReadingsLeftOut {
  readonly readings: number;
  readonly change_points: number;
}

/** The readings a log kept, oldest first, and what it left out (absent
 * when it kept every reading). */
export interface KeptReadings {
  readonly readings: ClaimReading[];
  readonly left_out?: ReadingsLeftOut;
}

/** Collects a poll's readings in bounded memory (`CLAIM_READINGS_CAP`
 * readings and one more), keeping what `keptReadings` names. `content`
 * is what `readingOf` returned beside the reading, and defaults to the
 * reading as kept. */
export interface ReadingsLog {
  readonly add: (reading: ClaimReading, content?: string) => void;
  readonly kept: () => KeptReadings;
}

/** What a reading read, without when it happened or its number: two
 * readings with one content read the same thing. */
function readingContent(reading: ClaimReading): string {
  return JSON.stringify([reading.held, reading.actuals ?? null, reading.expecteds ?? null, reading.error ?? null]);
}

export function createReadingsLog(cap = CLAIM_READINGS_CAP): ReadingsLog {
  const headCap = Math.floor((cap - 2) / 2);
  const tailCap = cap - 2 - headCap;
  // Every reading while there are at most `cap` of them.
  let all: ClaimReading[] | null = [];
  let total = 0;
  let first: ClaimReading | null = null;
  let previous: ClaimReading | null = null;
  let previousContent = "";
  // Whether `previous` differs from the reading before it. It joins the
  // change points only once a later reading shows it is not the last.
  let previousChanged = false;
  const head: ClaimReading[] = [];
  const tail: ClaimReading[] = [];
  let dropped = 0;
  return {
    add(reading, content = readingContent(reading)) {
      total += 1;
      if (all !== null) {
        all.push(reading);
        if (all.length > cap) all = null;
      }
      if (previous !== null && previousChanged) {
        if (head.length < headCap) head.push(previous);
        else {
          tail.push(previous);
          if (tail.length > tailCap) {
            tail.shift();
            dropped += 1;
          }
        }
      }
      if (first === null) {
        first = reading;
        previousChanged = false;
      } else {
        previousChanged = content !== previousContent;
      }
      previous = reading;
      previousContent = content;
    },
    kept() {
      if (all !== null) return { readings: [...all] };
      const readings = [first!, ...head, ...tail, previous!];
      return { readings, left_out: { readings: total - readings.length, change_points: dropped } };
    },
  };
}

/**
 * The readings a record keeps of `readings`, the rule `createReadingsLog`
 * applies as they arrive: every reading when there are at most `cap`;
 * otherwise the first, the last, and the change points between them (a
 * reading whose content differs from the one just before it), the
 * earliest `floor((cap - 2) / 2)` and the latest of the rest. Pure.
 */
export function keptReadings(readings: readonly ClaimReading[], cap = CLAIM_READINGS_CAP): KeptReadings {
  const log = createReadingsLog(cap);
  for (const reading of readings) log.add(reading);
  return log.kept();
}
