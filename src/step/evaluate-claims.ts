import type {
  ClaimCompare,
  ClaimComparisonRecord,
  ClaimEachRecord,
  ClaimItemDeclaration,
  ClaimItemIdentity,
  ClaimItemRecord,
  ClaimReading,
  ClaimReadingValue,
  ClaimView,
  MeasuredChannel,
} from "../record/types.js";
import { COUNT_COMPARES, judgeCount, type CountCompare, type CountReading } from "../execution-events/count.js";
import type { CountedGroup, LeftOutGroup } from "../execution-events/counted.js";
import { judgeSnapshots } from "./aria-snapshot.js";
import {
  ARIA_SNAPSHOT_COMPARE,
  isEachClaim,
  KIND_JSON_TYPES,
  kindNamed,
  NO_EVENTS,
  NO_FILES,
  literalStatedByAll,
  ORDER_COMPARES,
  pathSegments,
  placeAriaSnapshot,
  placeAt,
  placeCounted,
  placesOverlap,
  placeViewed,
  readOneItemValue,
  samePlace,
  type Claim,
  type ClaimLiteral,
  type ClaimPlace,
  type ComparisonClaim,
  type EachClaim,
  type EventsShape,
  type ItemClaim,
  type ValueKind,
  VALUE_KINDS,
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
//
// A `from` value is the copy an earlier step's `returns` parsed, and a
// `z.object` there drops every key it does not declare. The step record
// names those keys (`returns_dropped`), so a claim that held on the copy
// and could come out otherwise with them is `unjudged` and names the
// step, the place, and the keys, and one that holds whatever they were
// still holds.
//
// A `fits-aria-snapshot` claim reads no JSON value `observe` returned:
// its actual is the text of the ARIA snapshot nukadoko took of the locator
// or page there, right after `observe` returned (src/run/aria-reads.ts),
// and that text is what is compared and what the record shows.
//
// A claim on a count of execution events reads no snapshot: its actual
// is the range nukadoko counted (src/execution-events/count.ts), and it
// holds or breaks only when every count in the range gives that answer.
//
// A claim on the files an earlier step changed reads no snapshot either:
// its actual is the list of paths the runner read from that step's record
// (src/run/changed-files.ts), or why there is none, and the list is judged
// as any other value is.

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

/** Whether two arrays hold the same items, each as many times, in any
 * order: a duplicate on one side needs its own match on the other, so
 * `["a", "a"]` is not `["a"]` in another order. Pure. */
export function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  const unmatched = [...b];
  for (const item of a) {
    const index = unmatched.findIndex((other) => deepEqual(item, other));
    if (index === -1) return false;
    unmatched.splice(index, 1);
  }
  return true;
}

/** Where an expected object first fails to fit an actual one under
 * `has-fields`: a field the actual value lacks, a value that differs, or
 * an array of another length. `path` holds keys and indexes from the
 * top. */
export type FieldMisfit =
  | { readonly kind: "missing"; readonly path: readonly string[]; readonly expected: unknown }
  | { readonly kind: "differs"; readonly path: readonly string[]; readonly actual: unknown; readonly expected: unknown }
  | { readonly kind: "length"; readonly path: readonly string[]; readonly actual: number; readonly expected: number };

/** The first place, in the expected value's key order, where `expected`
 * does not fit `actual`, or `null` when it fits. An expected object fits an
 * object that holds each of its fields with a value that fits, whatever
 * other fields it holds, so a sentence can state the few fields of a large
 * response it is about. An expected array fits an array of the same length
 * whose items fit one by one: an extra item is a different list, not a
 * detail left out. Any other value fits only an equal one. The run judges
 * with this function and the run summary names the misfit with it, so the
 * two never disagree. Pure. */
export function fieldMisfit(actual: unknown, expected: unknown, path: readonly string[] = []): FieldMisfit | null {
  const expectedType = jsonType(expected);
  if (expectedType === "object") {
    if (jsonType(actual) !== "object") return { kind: "differs", path, actual, expected };
    const have = actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      if (!Object.hasOwn(have, key)) return { kind: "missing", path: [...path, key], expected: value };
      const found = fieldMisfit(have[key], value, [...path, key]);
      if (found !== null) return found;
    }
    return null;
  }
  if (expectedType === "array") {
    if (!Array.isArray(actual)) return { kind: "differs", path, actual, expected };
    const want = expected as unknown[];
    if (actual.length !== want.length) return { kind: "length", path, actual: actual.length, expected: want.length };
    for (let index = 0; index < want.length; index += 1) {
      const found = fieldMisfit(actual[index], want[index], [...path, String(index)]);
      if (found !== null) return found;
    }
    return null;
  }
  return deepEqual(actual, expected) ? null : { kind: "differs", path, actual, expected };
}

/** The path of the first object with no field in `value`, at any depth and
 * inside arrays too, or `null`. Under `has-fields` such an object fits every
 * object, so it states nothing. Pure. */
export function fieldlessObject(value: unknown, path: readonly string[] = []): readonly string[] | null {
  const type = jsonType(value);
  if (type !== "object" && type !== "array") return null;
  const entries = type === "array" ? (value as unknown[]).map((item, index) => [String(index), item] as const) : Object.entries(value as Record<string, unknown>);
  if (type === "object" && entries.length === 0) return path;
  for (const [key, item] of entries) {
    const found = fieldlessObject(item, [...path, key]);
    if (found !== null) return found;
  }
  return null;
}

/** An expected line under `fits-text` that stands for any run of actual
 * lines, none included. */
export const ANY_LINES = "...";

/** Inside any other expected line, a stand-in for any run of characters
 * in that one line. */
export const ANY_TEXT = "[..]";

/** A text's lines: split at each "\n" or "\r\n", with one final empty line
 * dropped, so the newline a program prints last does not count as a line.
 * A program on Windows ends its lines with "\r\n", and a docstring's lines
 * end with "\n" wherever the feature file was written, so the two breaks
 * read the same; any other "\r" stays in its line. Pure. */
export function fitLines(text: string): readonly string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Whether `line` fits the expected line `pattern`, where each `[..]`
 * stands for any characters. Pure. */
export function lineFits(pattern: string, line: string): boolean {
  return partsFit(pattern.split(ANY_TEXT), line);
}

/** Whether `line` fits an expected line already split at each `[..]`. The
 * first part is a prefix, the last a suffix, and each part between is found
 * leftmost after the one before it, which is enough when a stand-in matches
 * anything: a later find never needs an earlier part placed further right.
 * No backtracking, so a line costs time in its length, whatever an expected
 * line holds. */
function partsFit(parts: readonly string[], line: string): boolean {
  if (parts.length === 1) return parts[0] === line;
  const first = parts[0]!;
  const last = parts.at(-1)!;
  if (line.length < first.length + last.length || !line.startsWith(first) || !line.endsWith(last)) return false;
  let at = first.length;
  const end = line.length - last.length;
  for (let index = 1; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const found = line.indexOf(part, at);
    if (found === -1 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

/** How far an expected text fits an actual one under `fits-text`. When it
 * does not, `fitted` counts the expected lines that fit from the first,
 * `expected` is the next expected line, which fits nothing from actual
 * line `at` (1-based) on, and `actual` is that line; `expected` is absent
 * when every expected line fit and actual lines are left over from `at`.
 * An `actual` that is absent is past the end of the actual text. */
export type TextFit =
  | { readonly fits: true }
  | { readonly fits: false; readonly fitted: number; readonly expected?: string; readonly at: number; readonly actual?: string };

/** The actual lines the expected lines so far can end just before: every
 * index from `from` on, which a `...` line makes, or the indexes in `at`,
 * ascending, which any other line makes. */
type Reach = { readonly from: number } | { readonly at: readonly number[] };

/** Whether `expected` fits `actual` line by line: a line that is exactly
 * `...` takes any run of actual lines, `[..]` any characters inside one
 * line, and every other character matches itself, until both texts are
 * used up. The run judges with this function and the run summary names
 * where it stopped fitting with it, so the two never disagree.
 *
 * It walks the expected lines once and tries each against the actual
 * lines it can start at alone. A `...` line opens every later line, and
 * the next line tries each of them once; any other line moves each place
 * it fits one line on, so without a `...` there is at most one place and
 * the cost is linear in the expected lines. Trying each way a `...` could
 * split the text would cost a power of the number of `...` lines, and
 * walking every actual line for each expected line took 25 seconds on a
 * 200000-line output. Pure. */
export function textFit(actual: string, expected: string): TextFit {
  const have = fitLines(actual);
  const lines = fitLines(expected);
  const want = lines.map((line) => (line === ANY_LINES ? null : line.split(ANY_TEXT)));
  let reach: Reach = { at: [0] };
  for (const [index, parts] of want.entries()) {
    const earliest: number = "from" in reach ? reach.from : reach.at[0]!;
    if (parts === null) {
      reach = { from: earliest };
      continue;
    }
    const next: number[] = [];
    const tryAt = (j: number): void => {
      if (j < have.length && partsFit(parts, have[j]!)) next.push(j + 1);
    };
    if ("from" in reach) for (let j = reach.from; j < have.length; j += 1) tryAt(j);
    else for (const j of reach.at) tryAt(j);
    if (next.length === 0) return { fits: false, fitted: index, expected: lines[index]!, at: earliest + 1, ...(have[earliest] === undefined ? {} : { actual: have[earliest] }) };
    reach = { at: next };
  }
  if ("from" in reach) return { fits: true };
  const left = reach.at.at(-1)!;
  if (left === have.length) return { fits: true };
  return { fits: false, fitted: want.length, at: left + 1, actual: have[left]! };
}

/** Whether an expected text states nothing beyond its stand-ins: every
 * character outside `...` lines and `[..]` is whitespace, so nearly
 * every text fits it. Pure. */
export function onlyStandIns(expected: string): boolean {
  return fitLines(expected).every((line) => line === ANY_LINES || line.split(ANY_TEXT).join("").trim() === "");
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Whether a year, a month, and a day name a day of the calendar. */
function isCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= days;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Seconds are required and a leap second (60) is refused: a time a
// program generates names its second, and no runtime clock prints 60. The
// separator may be "T", "t", or a space, the zone "Z" or "z", and the
// offset "+hh:mm", "+hhmm", or "+hh": RFC 3339 allows the first two
// spellings, ISO 8601 the offsets, and programs print all of them.
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2})(?::?(\d{2}))?)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDate(value: unknown): boolean {
  const match = typeof value === "string" ? DATE.exec(value) : null;
  return match !== null && isCalendarDay(Number(match[1]), Number(match[2]), Number(match[3]));
}

function isTimestamp(value: unknown): boolean {
  const match = typeof value === "string" ? TIMESTAMP.exec(value) : null;
  if (match === null || !isCalendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) return false;
  const [hour, minute, second] = [Number(match[4]), Number(match[5]), Number(match[6])];
  const offset = match[7] === undefined ? true : Number(match[7]) <= 23 && Number(match[8] ?? 0) <= 59;
  return hour <= 23 && minute <= 59 && second <= 59 && offset;
}

// The URL parser takes "http:example.com" and strips or encodes spaces and
// line breaks, so a text it accepts can still be no URL a program wrote:
// the scheme has to be followed by "//", and no whitespace, control
// character (C0 and C1), or format character (a zero-width space, a word
// joiner, a byte order mark) may appear, since a reader cannot see one.
function isUrl(value: unknown): boolean {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value) || /[\s\p{Cc}\p{Cf}]/u.test(value)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** What a value of each kind `is-a` names is. A new kind is a new row
 * here and a new name in `VALUE_KINDS`. */
const KIND_TESTS: Readonly<Record<ValueKind, (value: unknown) => boolean>> = {
  string: (value) => typeof value === "string",
  text: (value) => typeof value === "string",
  number: (value) => typeof value === "number",
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
  list: (value) => Array.isArray(value),
  array: (value) => Array.isArray(value),
  object: (value) => jsonType(value) === "object",
  null: (value) => value === null,
  uuid: (value) => typeof value === "string" && UUID.test(value),
  date: isDate,
  timestamp: isTimestamp,
  url: isUrl,
};

/** The test of the kind `name` names (`kindNamed`), or `undefined` for a
 * name that is no kind. Pure. */
export function valueKind(name: string): ((value: unknown) => boolean) | undefined {
  const kind = kindNamed(name);
  return kind === undefined ? undefined : KIND_TESTS[kind];
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
    case "comma-list": {
      const text = value.trim();
      return { value: text === "" ? [] : text.split(",").map((item) => item.trim()) };
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
 * empty string) breaks too, and so does an expected object with no field,
 * which every object holds. */
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
    case "fits-text": {
      if (actualType !== "string" || expectedType !== "string") {
        return { reason: `fits-text reads two strings, and compares ${article(actualType)} with ${article(expectedType)}` };
      }
      if (onlyStandIns(expected as string)) {
        return { reason: "fits-text has an expected text of only whitespace, ... lines, and [..], which almost every text holds" };
      }
      return { holds: textFit(actual as string, expected as string).fits };
    }
    case "fits-aria-snapshot": {
      if (actualType !== "string" || expectedType !== "string") {
        return { reason: `fits-aria-snapshot reads two ARIA snapshots as texts, and compares ${article(actualType)} with ${article(expectedType)}` };
      }
      const judged = judgeSnapshots(actual as string, expected as string);
      if ("broken" in judged) return { reason: judged.broken };
      if ("unjudged" in judged) return { stopped: judged.unjudged };
      return { holds: judged.fits };
    }
    case "is-a": {
      // One of the two compares whose sides differ in type by design (the
      // other is lacks-field): the expected side names a kind, and the actual
      // value is of it.
      if (expectedType !== "string") return { reason: `is-a reads the name of a kind as a string, and the expected value is ${article(expectedType)}` };
      const kind = valueKind(expected as string);
      if (kind === undefined) {
        return { reason: `is-a names one of the kinds ${VALUE_KINDS.join(", ")}, and the expected value is ${JSON.stringify(expected)}` };
      }
      return { holds: kind(actual) };
    }
    case "lacks-field": {
      // The other compare whose sides differ in type by design: the
      // expected side names a field, and the actual object has no own key
      // of that name. A key set to null is present, so "has no password
      // field" breaks on { password: null }; a key whose value is
      // undefined is not in the snapshot, as JSON would not write it.
      if (actualType !== "object") return { reason: `lacks-field reads an object, and the actual value is ${article(actualType)}` };
      if (expectedType !== "string") return { reason: `lacks-field reads the name of a field as a string, and the expected value is ${article(expectedType)}` };
      if ((expected as string).trim() === "") return { reason: "lacks-field has a blank field name, which almost every object lacks" };
      return { holds: !Object.hasOwn(actual as object, expected as string) };
    }
    case "has-item": {
      if (actualType !== "array") return { reason: `has-item reads an array, and the actual value is ${article(actualType)}` };
      const items = actual as unknown[];
      if (items.length > 0 && !items.some((item) => jsonType(item) === expectedType)) {
        return { reason: `has-item looks for ${article(expectedType)}, and no item is one` };
      }
      return { holds: items.some((item) => deepEqual(item, expected)) };
    }
    case "has-same-items": {
      if (actualType !== "array" || expectedType !== "array") {
        return { reason: `has-same-items compares two arrays, and compares ${article(actualType)} with ${article(expectedType)}` };
      }
      return { holds: sameItems(actual as unknown[], expected as unknown[]) };
    }
    case "has-fields": {
      if (actualType !== "object" || expectedType !== "object") {
        return { reason: `has-fields compares two objects, and compares ${article(actualType)} with ${article(expectedType)}` };
      }
      const empty = fieldlessObject(expected);
      if (empty !== null) {
        return { reason: `has-fields has an expected object with no field${empty.length === 0 ? "" : ` at ${empty.join(".")}`}, which every object holds` };
      }
      return { holds: fieldMisfit(actual, expected) === null };
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
  /** The paths into what `observe` returned whose ARIA snapshot nukadoko
   * takes, for a `fits-aria-snapshot` claim: the value there is a locator
   * or a page, which no plain JSON snapshot holds. */
  readonly ariaSnapshots: readonly (readonly string[])[];
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

export function claimReads(claims: readonly Claim[], fromKeys: ReadonlySet<string>, events: EventsShape = NO_EVENTS, files: ReadonlySet<string> = NO_FILES): ClaimReads {
  const args = new Map<string, readonly string[]>();
  const observed = new Map<string, readonly string[]>();
  const ariaSnapshots = new Map<string, readonly string[]>();
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
    // A count of execution events, and a list of changed files, is no
    // value a snapshot holds.
    if (!isEachClaim(claim) && (events.keys.has(claim.actual) || files.has(claim.actual))) {
      addExpected(claim.expected);
      continue;
    }
    const segments = actualSegments(claim);
    const fromArgs = segments !== null && fromKeys.has(segments[0]!);
    const ariaSnapshot = !isEachClaim(claim) && claim.compare === ARIA_SNAPSHOT_COMPARE;
    if (segments !== null) add(fromArgs ? args : ariaSnapshot ? ariaSnapshots : observed, segments);
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
  // What a selection takes from the sentence is read before the schema
  // runs, as an expected sentence key is.
  for (const value of events.sentenceValues) add(args, [value.name]);
  return {
    args: [...args.values()],
    observed: [...observed.values()],
    ariaSnapshots: [...ariaSnapshots.values()],
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
  /** The ARIA snapshot nukadoko took, right after `observe` returned, of
   * the locator or page at each path a `fits-aria-snapshot` claim reads
   * (`ClaimReads.ariaSnapshots`); absent when it took none. */
  readonly ariaSnapshots?: (segments: readonly string[]) => AriaSnapshotRead;
  /** Where the args schema's output differs from the snapshot at a place
   * a claim reads (`segments`, read as one value, or item by item for an
   * `each`), or `null`: a claim on such a value would judge something the
   * line or the earlier step did not give. */
  readonly schemaChanged: (segments: readonly string[], itemwise: boolean) => readonly string[] | null;
  readonly fromKeys: ReadonlySet<string>;
  /** The args keys `observe` received: every key but an expected one for
   * a step with `observe`, none for a step without it. */
  readonly observeReceived: readonly string[];
  /** The from keys a claim's actual starts with that `observe` also
   * returned: the claim reads the from value, never the reading, so it is
   * broken, naming the key. Absent or empty when there is none. */
  readonly shadowedByObserve?: ReadonlySet<string>;
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
  /** What an earlier step's `returns` dropped from the object at an
   * args path (`[key, ...path]`) of a `from` value, as `DroppedKeys`;
   * `null` (or absent) where it dropped nothing, and for a value no
   * `returns` parsed. A claim that held on the value without those keys,
   * and could come out otherwise with them, is `unjudged`
   * (`droppedChange`). */
  readonly droppedAt?: (segments: readonly string[]) => DroppedKeys | null;
  readonly patterns: readonly string[];
  readonly testPattern: PatternTester;
  readonly budget: JudgingBudget;
  /** Each events key of the step as its claims read it; absent for a
   * step with no `events`. */
  readonly events?: ReadonlyMap<string, EventsCountSide>;
  /** Each files key of the step as its claims read it; absent for a step
   * with no `files`. */
  readonly files?: ReadonlyMap<string, FilesSide>;
}

/** What nukadoko's ARIA snapshot of the value at one path of `observe`'s
 * result found: the text the browser printed, or why there is none, as a
 * phrase that follows the place's name. A value that is no locator or
 * page breaks the claim, since `observe` returns it on every reading; a
 * snapshot the browser could not take (a locator that matched nothing in
 * time, or more than one element) leaves it unjudged, since nothing was
 * measured. */
export type AriaSnapshotRead = { readonly text: string } | { readonly broken: string } | { readonly unjudged: string };

/** One files key as a claim reads it: the label the record names the list
 * by (`files:<step>@<line> <changes>`, then ` under <dir>`), and the
 * sorted paths the earlier step's `runCommand` processes changed, with the
 * channel of its record they were read from, or why there is no list. */
export type FilesSide =
  | { readonly label: string; readonly paths: readonly string[]; readonly measured: MeasuredChannel }
  | { readonly label: string; readonly unjudged: string };

/** What nukadoko knows of the keys an earlier step (`step`) had its
 * `returns` drop from one object of the value it returned: the keys its
 * step record names (`keys`, never empty), that the record says it could
 * not see which, and why (`unseen`), or, for a record that does not say,
 * the keys the `z.object` there declares, so that any other key is one
 * it may have dropped (`declared`). */
export type DroppedKeys =
  | { readonly step: string; readonly keys: readonly string[] }
  | { readonly step: string; readonly unseen: string }
  | { readonly step: string; readonly declared: readonly string[] };
/** One events key as a claim reads it: the label the record names the
 * count by (`events:<step>@<line> count <selection>`), and the step's
 * reading with the name of the step whose events it counted and the
 * lines it counted and left out, or why there is none. A selection whose sentence
 * value does not fit its field breaks the claim, since the line states
 * what the format cannot select by, and a reading nukadoko could not make
 * leaves it unjudged. */
export type EventsCountSide =
  | {
      readonly label: string;
      readonly of: string;
      readonly reading: CountReading;
      readonly counted: readonly CountedGroup[];
      readonly left_out?: readonly LeftOutGroup[];
    }
  | { readonly label: string; readonly broken: string }
  | { readonly label: string; readonly unjudged: string };

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
  /** The events key a claim on a count of execution events read: its
   * actual was measured on the claim step's own `events_read.<key>`.
   * Absent when the step holds no reading of the key. */
  readonly eventsKey?: string;
  /** A claim on files only: the channel of the earlier step's record its
   * list was read from, which is where it was measured by construction.
   * Absent when there was no list. */
  readonly filesChannel?: MeasuredChannel;
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
  if ("missing" in read) return { place, broken: `${name(place)} is undefined${firstMissing(read.missing - skip, base, rest)}` };
  return { place, value: read.value };
}

/** Where a path found nothing first, when that was above its last segment,
 * so "body.profile.name is undefined" says whether body had no profile or
 * profile had no name; "" when the last segment is what is missing. */
function firstMissing(index: number, base: ClaimPlace, rest: readonly string[]): string {
  if (index >= rest.length - 1) return "";
  if (index < 0) return `, since ${nameOf(base)} is undefined`;
  return `, since ${nameOf(placeAt(base, rest.slice(0, index).join(".")))} has nothing at ${rest[index]!}`;
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
  if (!isEachClaim(claim) && claim.compare === ARIA_SNAPSHOT_COMPARE) return { ...ariaSnapshotSide(path, fromKey, inputs), fromKey, atRead: false };
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

/** The side a `fits-aria-snapshot` claim reads: the ARIA snapshot
 * nukadoko took of the locator or page `observe` returned at `path`.
 * `defineStep` refuses such a claim on a `from` value; one that reaches
 * here anyway breaks, since a value an earlier step returned is plain
 * JSON, and a text there would be a tree step code wrote. */
function ariaSnapshotSide(path: readonly string[], fromKey: string | null, inputs: ClaimInputs): Side {
  const read = fromKey === null ? placeAt(OBSERVE_PLACE, path.join(".")) : placeAt(argPlace(fromKey, inputs), path.slice(1).join("."));
  const place = placeAriaSnapshot(read);
  if (fromKey !== null) return { place, broken: `${read.label} is a value an earlier step returned, and fits-aria-snapshot takes the ARIA snapshot of a locator or page that observe returns` };
  const taken = inputs.ariaSnapshots?.(path) ?? { unjudged: "has no ARIA snapshot nukadoko took, so the claim was not judged" };
  if ("text" in taken) return { place, value: taken.text };
  return "broken" in taken ? { place, broken: `${read.label} ${taken.broken}` } : { place, unjudged: `${read.label} ${taken.unjudged}` };
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

/** A side counted, when the claim counts: the number of items of the
 * array the side holds, at a place that says it was counted, or why
 * there is none. A value that is not an array breaks the claim rather
 * than count as one item or none, since either would be a guess. */
function counted(side: Side, count: boolean | undefined): Side {
  if (count !== true) return side;
  const place = placeCounted(side.place, count);
  if (!("value" in side)) return "broken" in side ? { place, broken: side.broken } : { place, unjudged: side.unjudged };
  if (!Array.isArray(side.value)) return { place, broken: `count reads an array, and the value is ${article(jsonType(side.value))}` };
  return { place, value: side.value.length };
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
 * carry the value; on the other side the actual `from` key is held back
 * too (`observeWithheldKeys`), so again only a second key can. `nuka check` refuses
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

/** What stops a claim on a count before it is judged, on its expected
 * side: the same rules a comparison's expected side follows. */
function expectedStop(expected: ExpectedSide, inputs: ClaimInputs): Stop {
  const stop = schemaChange(expected.segments, inputs) ?? stopOf(expected);
  if (stop !== null) return stop;
  const received = observeReceived(expected.place, inputs, "the expected value reads");
  if (received !== null) return received;
  if (expected.fromObserve && "value" in expected && typeof expected.value === "boolean") {
    return { broken: `the expected value ${expected.place.label} is a boolean observe computed, which is a judgment made in code: return the thing measured and let the claim compare it` };
  }
  return null;
}

function isCountCompare(compare: string): compare is CountCompare {
  return (COUNT_COMPARES as readonly string[]).includes(compare);
}

/** A claim on a count of execution events: the range the step read
 * against the expected number. `actual` is the count when the range is
 * one number, and `actual_range` the range otherwise, with the lines it
 * counted, and those it left out, beside it. */
function judgeEventsCount(claim: ComparisonClaim, side: EventsCountSide, inputs: ClaimInputs): ClaimComparisonRecord {
  const expected = expectedSide(claim, inputs);
  const range = "reading" in side ? side.reading.range : null;
  const base = {
    ...(range === null ? {} : range.at_most === range.at_least ? { actual: range.at_least } : { actual_range: { ...range } }),
    ...("counted" in side ? { counted: side.counted } : {}),
    ...("left_out" in side && side.left_out !== undefined ? { left_out: side.left_out } : {}),
    actual_from: side.label,
    compare: claim.compare,
    ...("value" in expected ? { expected: expected.value } : {}),
    expected_from: expected.place.label,
    expected_text: expected.text,
  };
  const stop: Stop = "broken" in side ? { broken: side.broken } : "unjudged" in side ? { unjudged: side.unjudged } : expectedStop(expected, inputs);
  if (stop !== null) return "broken" in stop ? { ...base, outcome: "broken", reason: stop.broken } : { ...base, outcome: "unjudged", reason: stop.unjudged };
  const value = (expected as { value: unknown }).value;
  if (!isCountCompare(claim.compare)) {
    return { ...base, outcome: "broken", reason: `a count of execution events is a number, and ${claim.compare} does not compare two numbers` };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ...base, outcome: "broken", reason: `the expected value ${expected.place.label} is ${article(jsonType(value))}, and a count of execution events is compared with a number` };
  }
  const judgment = judgeCount((side as { reading: CountReading }).reading, claim.compare, value, (side as { of: string }).of);
  return judgment.outcome === "unjudged" ? { ...base, outcome: "unjudged", reason: judgment.reason } : { ...base, outcome: judgment.outcome };
}

function declarationOf(claim: ItemClaim, expected: ExpectedSide | null): ClaimItemDeclaration {
  const place = expected?.place ?? expectedPlace(claim, null);
  return {
    ...(claim.actual === undefined ? {} : { actual: claim.actual }),
    ...(claim.view === undefined ? {} : { view: claim.view }),
    ...(claim.at === undefined ? {} : { at: claim.at }),
    ...(claim.count === undefined ? {} : { count: claim.count }),
    compare: claim.compare,
    ...(expected !== null && "value" in expected ? { expected: expected.value } : {}),
    expected_from: place.label,
    ...(claim.expected_view === undefined ? {} : { expected_view: claim.expected_view }),
    expected_text: expected?.text ?? null,
  };
}

/** How `judgeComparison` reads one comparison. `readSegments` is the
 * args path the args schema's output is compared at for the claim as a
 * whole, `atRead` says its `at` was read there already, `valuePath` is
 * the args path of the actual value before `view` and `count`, an item's
 * too, and `where` marks a `where` clause, whose broken outcome decides
 * which items an `each` selects. */
interface Judging {
  readonly readSegments?: readonly string[] | null;
  readonly atRead?: boolean;
  readonly valuePath?: readonly string[] | null;
  readonly where?: boolean;
}

async function judgeComparison(claim: ItemClaim, rawActual: Side, inputs: ClaimInputs, judging: Judging = {}): Promise<ClaimComparisonRecord> {
  const { readSegments = null, atRead = false, valuePath = null, where = false } = judging;
  const expected = expectedSide(claim, inputs);
  const actual = counted(shaped(rawActual, claim.view, claim.at, atRead), claim.count);
  // Field order is the order a reader reads a claim in: what was measured,
  // how, and what it was compared with.
  const base = {
    ...("value" in actual ? { actual: actual.value } : {}),
    actual_from: actual.place.label,
    ...(claim.view === undefined ? {} : { view: claim.view }),
    ...(claim.at === undefined ? {} : { at: claim.at }),
    ...(claim.count === undefined ? {} : { count: claim.count }),
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
  // A view or a count makes a value of its own, which no returns parsed.
  const actualSide = dropSide(actual.place, claim.view === undefined && claim.count !== true ? valuePath : null, inputs);
  const expectedSideDrops = dropSide(expected.place, claim.expected_view === undefined ? expected.segments : null, inputs);
  const changed = droppedChange(
    claim.compare,
    result.holds,
    { value: (actual as { value: unknown }).value, side: actualSide },
    { value: (expected as { value: unknown }).value, side: expectedSideDrops },
    where,
  );
  if (changed !== null) return { ...base, outcome: "unjudged", reason: changed };
  return { ...base, outcome: result.holds ? "held" : "broken" };
}

// --- what an earlier step's returns dropped ---

/** One side of a comparison as `droppedChange` reads it: its place, and
 * what was dropped from the object at each path inside its value. */
interface DropSide {
  readonly place: ClaimPlace;
  readonly drops: (rel: readonly string[]) => DroppedKeys | null;
}

/** A side's value with the side it is read from. */
interface Compared {
  readonly value: unknown;
  readonly side: DropSide;
}

const NO_DROPS = (): null => null;

/** The side at `place`, whose value sits at the args path `path`, or at
 * none (`null`): a value the line states, `observe` returned, or a view
 * or a count made. */
function dropSide(place: ClaimPlace, path: readonly string[] | null, inputs: ClaimInputs): DropSide {
  const droppedAt = inputs.droppedAt;
  return { place, drops: path === null || droppedAt === undefined ? NO_DROPS : (rel) => droppedAt([...path, ...rel]) };
}

/** What was dropped from one object, and where the object sits. */
interface FoundDrop {
  readonly place: ClaimPlace;
  readonly dropped: DroppedKeys;
}

function foundAt(side: DropSide, rel: readonly string[], dropped: DroppedKeys): FoundDrop {
  return { place: placeAt(side.place, rel.join(".")), dropped };
}

/** Whether `key` may be one of the keys `dropped` stands for. */
function mayHaveDropped(dropped: DroppedKeys, key: string): boolean {
  if ("keys" in dropped) return dropped.keys.includes(key);
  if ("declared" in dropped) return !dropped.declared.includes(key);
  return true;
}

/** The first object inside `value`, itself included, that had a key
 * dropped, or may have had one, with where it sits. Pure. */
function firstDrop(value: unknown, side: DropSide, rel: readonly string[] = []): FoundDrop | null {
  const type = jsonType(value);
  if (type !== "object" && type !== "array") return null;
  if (type === "object") {
    const dropped = side.drops(rel);
    if (dropped !== null) return foundAt(side, rel, dropped);
  }
  const entries = type === "array" ? (value as unknown[]).map((item, index) => [String(index), item] as const) : Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries) {
    const found = firstDrop(item, side, [...rel, key]);
    if (found !== null) return found;
  }
  return null;
}

/** Whether two values were equal as the steps returned them, before any
 * key was dropped: `equal` or `unequal` for certain, or `unknown`,
 * with the drop the answer turns on (`via`, `null` when none does). */
interface Equality {
  readonly answer: "equal" | "unequal" | "unknown";
  readonly via: FoundDrop | null;
}

const EQUAL: Equality = { answer: "equal", via: null };
const UNEQUAL: Equality = { answer: "unequal", via: null };

/** `Equality` of `a` (at `relA` of side `A`) and `b` (at `relB` of
 * `B`). A dropped key never changes a value's JSON type or an array's
 * length, and a dropped key's value is not known, so two objects can be
 * equal as returned only where each key one of them holds or dropped is a
 * key the other holds or may have dropped. Pure. */
function rawEquality(a: unknown, b: unknown, A: DropSide, B: DropSide, relA: readonly string[] = [], relB: readonly string[] = []): Equality {
  const type = jsonType(a);
  if (type !== jsonType(b)) return UNEQUAL;
  if (type === "array") {
    const left = a as unknown[];
    const right = b as unknown[];
    if (left.length !== right.length) return UNEQUAL;
    let open: FoundDrop | null = null;
    for (let index = 0; index < left.length; index += 1) {
      const item = rawEquality(left[index], right[index], A, B, [...relA, String(index)], [...relB, String(index)]);
      if (item.answer === "unequal") return item;
      if (item.answer === "unknown") open ??= item.via;
    }
    return open === null ? EQUAL : { answer: "unknown", via: open };
  }
  if (type !== "object") return deepEqual(a, b) ? EQUAL : UNEQUAL;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const droppedA = A.drops(relA);
  const droppedB = B.drops(relB);
  let open: FoundDrop | null = null;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const inLeft = Object.hasOwn(left, key);
    if (inLeft && Object.hasOwn(right, key)) {
      const field = rawEquality(left[key], right[key], A, B, [...relA, key], [...relB, key]);
      if (field.answer === "unequal") return field;
      if (field.answer === "unknown") open ??= field.via;
      continue;
    }
    // A key one side holds was in the other side's value only if that
    // side's object dropped it.
    const [side, rel, dropped] = inLeft ? [B, relB, droppedB] : [A, relA, droppedA];
    if (dropped === null || !mayHaveDropped(dropped, key)) return UNEQUAL;
    open ??= foundAt(side, rel, dropped);
  }
  // Each key an object is known to have dropped was in its value, so the
  // other side's value held it too, or the two differ.
  const known: readonly (readonly [DroppedKeys | null, Record<string, unknown>, DroppedKeys | null, DropSide, readonly string[]])[] = [
    [droppedA, right, droppedB, A, relA],
    [droppedB, left, droppedA, B, relB],
  ];
  for (const [dropped, other, otherDropped, side, rel] of known) {
    if (dropped === null) continue;
    if (!("keys" in dropped)) {
      open ??= foundAt(side, rel, dropped);
      continue;
    }
    for (const key of dropped.keys) {
      if (!Object.hasOwn(other, key) && (otherDropped === null || !mayHaveDropped(otherDropped, key))) return { answer: "unequal", via: foundAt(side, rel, dropped) };
      open ??= foundAt(side, rel, dropped);
    }
  }
  return open === null ? EQUAL : { answer: "unknown", via: open };
}

/** Why a comparison that came out `holds` on the values the steps'
 * `returns` parsed may come out otherwise on the values the steps
 * returned, or `null`. A dropped key never changes a text, a number, a
 * kind, or an array's length, so only these compares turn on one:
 * `lacks-field` on a field the object dropped or may have dropped;
 * `equal`, `not-equal`, `has-item`, and `has-same-items` where the
 * values as returned may differ in such a key (`rawEquality`); and
 * `has-fields`, which holds on an actual object with more keys, where
 * the expected object had a key dropped. A broken comparison stays broken,
 * except in a `where` clause (`where`), where it decides which items an
 * `each` selects. Pure. */
function droppedChange(compare: ClaimCompare, holds: boolean, actual: Compared, expected: Compared, where: boolean): string | null {
  if (!holds && !where) return null;
  switch (compare) {
    case "lacks-field": {
      // A key the parsed object holds is no key its returns dropped.
      if (!holds) return null;
      const field = expected.value as string;
      const dropped = actual.side.drops([]);
      if (dropped === null || !mayHaveDropped(dropped, field)) return null;
      return droppedReason(foundAt(actual.side, [], dropped), "keys" in dropped ? `the ${field} field was there` : `a ${field} field may have been there`);
    }
    case "equal":
    case "not-equal": {
      const parsedEqual = compare === "equal" ? holds : !holds;
      const equality = rawEquality(actual.value, expected.value, actual.side, expected.side);
      if (equality.answer === (parsedEqual ? "equal" : "unequal") || equality.via === null) return null;
      const consequence = !parsedEqual
        ? "the two values may have been equal as returned"
        : equality.answer === "unequal"
          ? "the two values differed as returned"
          : "the two values may have differed as returned";
      return droppedReason(equality.via, consequence);
    }
    case "has-item": {
      const items = actual.value as unknown[];
      let via: FoundDrop | null = null;
      for (const [index, item] of items.entries()) {
        if (holds && !deepEqual(item, expected.value)) continue;
        const equality = rawEquality(item, expected.value, actual.side, expected.side, [String(index)], []);
        if (holds && equality.answer === "equal") return null;
        if (!holds && equality.answer !== "unequal") return equality.via === null ? null : droppedReason(equality.via, "an item may have equaled the expected value as returned");
        via ??= equality.via;
      }
      return holds && via !== null ? droppedReason(via, "no item is known to have equaled the expected value as returned") : null;
    }
    case "has-same-items": {
      if (!holds && (actual.value as unknown[]).length !== (expected.value as unknown[]).length) return null;
      const via = firstDrop(actual.value, actual.side) ?? firstDrop(expected.value, expected.side);
      return via === null ? null : droppedReason(via, holds ? "the items may have differed as returned" : "the items may have been the same as returned");
    }
    case "has-fields": {
      const via = holds ? firstDrop(expected.value, expected.side) : firstDrop(actual.value, actual.side);
      if (via === null) return null;
      return droppedReason(via, holds ? "the expected value may have held a field the actual value lacks" : "the actual value may have held the expected fields as returned");
    }
    default:
      return null;
  }
}

/** The reason a claim is not judged, naming the step, the place, and what
 * it dropped there, then `consequence`. */
function droppedReason(found: FoundDrop, consequence: string): string {
  const { place, dropped } = found;
  const what =
    "keys" in dropped
      ? `step "${dropped.step}" returned ${dropped.keys.join(", ")} at ${place.label}, and its returns dropped ${dropped.keys.length === 1 ? "it" : "them"}`
      : "unseen" in dropped
        ? `nukadoko could not see which keys the returns of step "${dropped.step}" dropped at ${place.label} (${dropped.unseen})`
        : `the record of step "${dropped.step}" does not say which keys its returns dropped, and its returns parses ${place.label} with an object schema that declares ${dropped.declared.length === 0 ? "no key" : dropped.declared.join(", ")} and drops any key it does not declare`;
  return `${what}, so ${consequence}, and the claim was not judged`;
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

/** The fields that name an item, in the order a failure looks for them. */
export const IDENTITY_FIELDS = ["id", "name", "key"] as const;

/** The first of `IDENTITY_FIELDS` an object item holds as a string or a
 * number, or `undefined`: an index alone does not tell a reader which
 * row of a report, or which file, broke. Pure. */
export function itemIdentity(item: unknown): ClaimItemIdentity | undefined {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
  for (const field of IDENTITY_FIELDS) {
    if (!Object.hasOwn(item, field)) continue;
    const value = (item as Record<string, unknown>)[field];
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return { field, value };
  }
  return undefined;
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
  // The args path of each item while it is the value an earlier step
  // returned: after a view, the items are values of the view's own.
  const arrayPath = claim.view === undefined ? readSegments : null;
  const itemPath = (index: number, entry: ItemClaim): readonly string[] | null => (arrayPath === null ? null : [...arrayPath, String(index), ...itemSegments(entry)]);
  for (let index = 0; index < items.length; index += 1) {
    if (inputs.budget.left() <= 0) return stopped(index);
    const itemPlace = placeAt(actual.place, String(index));
    const whereRecords: ClaimComparisonRecord[] = [];
    for (const entry of where) {
      whereRecords.push(await judgeComparison(entry, itemSide(items[index], itemPlace, entry), inputs, { valuePath: itemPath(index, entry), where: true }));
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
      claims.push(await judgeComparison(entry, itemSide(items[index], itemPlace, entry), inputs, { valuePath: itemPath(index, entry) }));
    }
    const outcome = itemOutcome(claims);
    const identity = outcome === "broken" ? itemIdentity(items[index]) : undefined;
    judged.push({
      index,
      selected: true,
      ...(whereRecords.length === 0 ? {} : { where: whereRecords }),
      outcome,
      claims,
      ...(identity === undefined ? {} : { identity }),
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
 * An order compare, or a not-equal, holds only on a value of its expected
 * value's JSON type, and a `where` that cannot compare an item breaks the
 * `each`, so an `is-a` claim of a kind that is that type alone
 * (`KIND_JSON_TYPES`) is implied too. Pure. */
export function whereImplies(where: ClaimCompare, whereValue: unknown, claim: ClaimCompare, claimValue: unknown): boolean {
  if (claim === "is-a") {
    const kind = typeof claimValue === "string" ? kindNamed(claimValue) : undefined;
    const type = where === "not-equal" ? jsonType(whereValue) : ORDER_COMPARES.has(where) && typeof whereValue === "number" ? "number" : null;
    return kind !== undefined && type !== null && KIND_JSON_TYPES[kind] === type;
  }
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
 * value (`readOneItemValue`) where the clause implies the claim
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
      if (!readOneItemValue(where, entry)) continue;
      const whereValue = expectedValue(where);
      const claimValue = expectedValue(entry);
      if (whereValue === null || claimValue === null || !whereImplies(where.compare, whereValue.value, entry.compare, claimValue.value)) continue;
      const viewed = where.view === undefined ? "" : ` as ${where.view}${where.at === undefined ? "" : ` at ${where.at}`}`;
      const what = `${where.count === true ? "count of " : ""}${place.length === 0 ? "value" : place.join(".")}${viewed}`;
      return (
        `each.where[${whereIndex}] selects the items whose ${what} is ${where.compare} ${JSON.stringify(whereValue.value)}, ` +
        `and every such item holds each.claims[${claimIndex}], ${entry.compare} ${JSON.stringify(claimValue.value)}, whatever the data, so the claim measures nothing`
      );
    }
  }
  return null;
}

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

function filesPlace(key: string, side: FilesSide): ClaimPlace {
  return { origin: `files:${key}`, segments: [], label: side.label, open: false };
}

function actualPlace(claim: Claim, inputs: ClaimInputs): ClaimPlace {
  const events = inputs.events?.get(claim.actual);
  if (events !== undefined) return { origin: "events", segments: [claim.actual], label: events.label, open: false };
  const files = inputs.files?.get(claim.actual);
  if (files !== undefined) return placeCounted(filesPlace(claim.actual, files), isEachClaim(claim) ? undefined : claim.count);
  const segments = pathSegments(claim.actual) ?? [claim.actual];
  const base = inputs.fromKeys.has(segments[0]!) ? placeAt(argPlace(segments[0]!, inputs), segments.slice(1).join(".")) : placeAt(OBSERVE_PLACE, claim.actual);
  if (!isEachClaim(claim) && claim.compare === ARIA_SNAPSHOT_COMPARE) return placeAriaSnapshot(base);
  return placeCounted(placeAt(placeViewed(base, claim.view), claim.at), isEachClaim(claim) ? undefined : claim.count);
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
    ...(claim.count === undefined ? {} : { count: claim.count }),
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

/** Why a claim whose actual starts with `key` is not judged when
 * `observe` returned `key` too: the claim reads the from value, or the
 * count of execution events, that `source` names. Pure. */
export function shadowedReason(key: string, source: "from" | "events" | "files" = "from"): string {
  if (source === "files") {
    return (
      `observe returned "${key}", and files has a key of the same name, so actual "${key}" reads the paths an earlier step's commands changed and never what observe returned. ` +
      `Rename the key observe returns, or the files key, so each name has one source`
    );
  }
  if (source === "events") {
    return (
      `observe returned "${key}", and events has a key of the same name, so actual "${key}" reads the count of execution events and never what observe returned. ` +
      `Rename the key observe returns, or the events key, so each name has one source`
    );
  }
  return (
    `observe returned "${key}", and from has a key of the same name, so actual "${key}" reads the from value and never what observe returned. ` +
    `Rename the key observe returns, or the from key, so each name has one source`
  );
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
    const events = isEachClaim(claim) ? undefined : inputs.events?.get(claim.actual);
    if (events !== undefined) {
      const eventsKey = claim.actual;
      const shadowed = inputs.shadowedByObserve?.has(eventsKey) === true;
      const record = shadowed ? notJudged(claim, inputs, "broken", shadowedReason(eventsKey, "events")) : judgeEventsCount(claim as ComparisonClaim, events, inputs);
      // Measured on the reading, when there is one to name.
      judged.push({ record, rawActual: undefined, fromKey: null, expectedOrigins, ...("reading" in events ? { eventsKey } : {}) });
      continue;
    }
    const files = isEachClaim(claim) ? undefined : inputs.files?.get(claim.actual);
    if (files !== undefined) {
      if (inputs.shadowedByObserve?.has(claim.actual) === true) {
        judged.push({ record: notJudged(claim, inputs, "broken", shadowedReason(claim.actual, "files")), rawActual: undefined, fromKey: null, expectedOrigins });
        continue;
      }
      const place = filesPlace(claim.actual, files);
      const side: Side = "paths" in files ? { place, value: [...files.paths] } : { place, unjudged: files.unjudged };
      const record = await judgeComparison(claim as ComparisonClaim, side, inputs);
      judged.push({ record, rawActual: undefined, fromKey: null, expectedOrigins, ...("paths" in files ? { filesChannel: files.measured } : {}) });
      continue;
    }
    if (fromKey !== null && inputs.shadowedByObserve?.has(fromKey) === true) {
      judged.push({ record: notJudged(claim, inputs, "broken", shadowedReason(fromKey)), rawActual: undefined, fromKey, expectedOrigins });
      continue;
    }
    let rawActual: unknown;
    try {
      const actual = topLevelSide(claim, inputs);
      rawActual = "value" in actual ? actual.value : undefined;
      const segments = actual.fromKey === null ? null : actualSegments(claim);
      const record = isEachClaim(claim)
        ? await judgeEach(claim, actual, segments, inputs, actual.atRead)
        : await judgeComparison(claim, actual, inputs, { readSegments: segments, atRead: actual.atRead, valuePath: segments });
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
