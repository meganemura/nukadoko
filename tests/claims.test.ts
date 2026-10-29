import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Generator } from "@hegeldev/hegel/generators";
import type { ClaimCompare, ClaimComparisonRecord, ClaimEachRecord } from "../src/record/types.js";
import { repoRoot } from "./helpers/fixtures.js";
import {
  ANY_INDEX,
  CLAIM_COMPARES,
  claimArgKeysRead,
  claimsProblem,
  COUNT_COMPARES,
  describeClaim,
  LITERAL_WORDS,
  literalStatedBy,
  literalStatement,
  NUMBER_WORDS,
  itemPathsOverlap,
  placeAt,
  placesOverlap,
  placeViewed,
  samePlace,
  type Claim,
  type ClaimPlace,
  type ClaimStepShape,
  VALUE_KINDS,
} from "../src/step/claims.js";
import {
  applyView,
  compareValues,
  deepEqual,
  evaluateClaims,
  fieldlessObject,
  fieldMisfit,
  fitLines,
  lineFits,
  textFit,
  jsonType,
  judgingBudget,
  pollReadings,
  POLL_INTERVAL_MS,
  readerNow,
  sameItems,
  itemIdentity,
  IDENTITY_FIELDS,
  whereImplies,
  type ClaimInputs,
  type PatternTester,
  type Reading,
} from "../src/step/evaluate-claims.js";
import { readAt, snapshot } from "../src/step/snapshot.js";
import { claimLine, equalDifference, fieldsDifference, fitsDifference, presentFieldDifference } from "../src/report/summary/claim-line.js";

// Responsibility: the judging rules of a claim (docs/spec.md "Claims") as
// properties over drawn values: each compare against its negation, a
// comparison across two JSON types, the plain-JSON gate on both sides,
// where two sides read (one place spelled two ways), `view` and `at` on
// drawn JSON, the literal rule word for word, `each` and what it records
// for every item, and the two consecutive readings `poll` rests a pass
// on. These are pure functions (the pattern tester aside, which the
// runner gives), so a property says what an example cannot: that no
// drawn value makes a rule bend.

function jsonValue(depth: number): Generator<unknown> {
  const leaf = gs.oneOf<unknown>(
    gs.just(null),
    gs.booleans(),
    gs.integers({ minValue: -30, maxValue: 30 }),
    gs.text({ alphabet: "ab", minSize: 0, maxSize: 3 }),
  );
  if (depth === 0) return leaf;
  const child = jsonValue(depth - 1);
  return gs.oneOf<unknown>(
    leaf,
    gs.arrays(child, { minSize: 0, maxSize: 3 }),
    gs.composite((tc) => {
      const count = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < count; i += 1) {
        obj[tc.draw(gs.text({ alphabet: "ab", minSize: 1, maxSize: 2 }))] = tc.draw(child);
      }
      return obj;
    }),
  );
}

const jsonValues = jsonValue(3);

/** A JSON object with at least one key, and a path of one or more
 * segments that walks into it, with the value at the end of the path. */
const rootWithPath: Generator<{ root: Record<string, unknown>; path: string; value: unknown }> = gs.composite((tc) => {
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
  const root: Record<string, unknown> = {};
  for (let i = 0; i < count; i += 1) {
    root[tc.draw(gs.text({ alphabet: "ab", minSize: 1, maxSize: 2 }))] = tc.draw(jsonValues);
  }
  const first = tc.draw(gs.sampledFrom(Object.keys(root)));
  const segments = [first];
  let current: unknown = root[first];
  for (;;) {
    const keys = Array.isArray(current)
      ? current.map((_, index) => String(index))
      : typeof current === "object" && current !== null
        ? Object.keys(current)
        : [];
    if (keys.length === 0 || !tc.draw(gs.booleans())) break;
    const key = tc.draw(gs.sampledFrom(keys));
    segments.push(key);
    current = Array.isArray(current) ? current[Number(key)] : (current as Record<string, unknown>)[key];
  }
  return { root, path: segments.join("."), value: current };
});

/** The runner tests a pattern on a worker it can stop; these properties
 * draw only short patterns over short texts, so the same test runs here. */
const testInProcess: PatternTester = async (pattern, text) => {
  let built: RegExp;
  try {
    built = new RegExp(pattern);
  } catch (error) {
    return { reason: `matches could not build a regular expression: ${(error as Error).message}` };
  }
  return { holds: built.test(text), matchesEmpty: new RegExp(pattern).test("") };
};

function inputs(args: Record<string, unknown>, observation: unknown, fromKeys: readonly string[] = []): ClaimInputs {
  return {
    args: readerNow(args),
    observed: readerNow(observation),
    schemaChanged: () => null,
    observeReceived: [],
    fromKeys: new Set(fromKeys),
    argSide: (key) =>
      fromKeys.includes(key)
        ? { origin: "record:produce", segments: [key], label: `from:produce@3.${key}` }
        : { origin: `sentence:${key}`, segments: [], label: `sentence:${key}` },
    sentenceText: (key) => (fromKeys.includes(key) || !(key in args) ? null : `text of ${key}`),
    patterns: ["the value is {want}"],
    testPattern: testInProcess,
    budget: judgingBudget(Number.POSITIVE_INFINITY, "a test's budget"),
  };
}

async function judgeOne(claim: Claim, args: Record<string, unknown>, observation: unknown, fromKeys: readonly string[] = []) {
  const [judged] = await evaluateClaims([claim], inputs(args, observation, fromKeys));
  return judged!.record;
}

function compare(compare: ClaimCompare, actual: unknown, expected: unknown) {
  return compareValues(compare, actual, expected, (pattern, text) => testInProcess(pattern, text, Number.POSITIVE_INFINITY, "a test"));
}

function article(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

const NEGATION_PAIRS: readonly (readonly [ClaimCompare, ClaimCompare])[] = [
  ["equal", "not-equal"],
  ["greater-than", "at-most"],
  ["less-than", "at-least"],
];

const ALL_COMPARES: readonly ClaimCompare[] = [
  "equal",
  "not-equal",
  "contains-text",
  "starts-with-text",
  "ends-with-text",
  "has-item",
  "has-same-items",
  "has-fields",
  "lacks-field",
  "fits-text",
  "is-a",
  "matches",
  "greater-than",
  "at-least",
  "less-than",
  "at-most",
];

function holds(result: { holds: boolean } | { reason: string } | { stopped: string }): boolean {
  if ("reason" in result) throw new Error(`expected a comparison, got the reason: ${result.reason}`);
  if ("stopped" in result) throw new Error(`expected a comparison, got: ${result.stopped}`);
  return result.holds;
}

describe("compares", () => {
  it("equal and not-equal disagree on every pair of values of one JSON type", () =>
    hegel.testAsync(async (tc) => {
      const a = tc.draw(jsonValues);
      const b = tc.draw(gs.booleans()) ? structuredClone(a) : tc.draw(jsonValues);
      tc.assume(jsonType(a) === jsonType(b));
      expect(holds(await compare("equal", a, b))).toBe(!holds(await compare("not-equal", a, b)));
      expect(holds(await compare("equal", a, b))).toBe(deepEqual(a, b));
    }));

  it("equal on two objects states exactly their fields: a field only one side has breaks it, null included, and the line names that field", () =>
    hegel.testAsync(async (tc) => {
      const fields = tc.draw(
        gs.composite((inner) => {
          const object: Record<string, unknown> = {};
          const count = inner.draw(gs.integers({ minValue: 0, maxValue: 3 }));
          for (let i = 0; i < count; i += 1) object[inner.draw(gs.text({ alphabet: "ab", minSize: 1, maxSize: 2 }))] = inner.draw(jsonValues);
          return object;
        }),
      );
      const extra = tc.draw(gs.text({ alphabet: "c", minSize: 1, maxSize: 2 }));
      const value = tc.draw(gs.oneOf<unknown>(gs.just(null), jsonValues));
      const wider = { ...fields, [extra]: value };
      const [actual, expected] = tc.draw(gs.booleans()) ? [wider, fields] : [fields, wider];
      expect(holds(await compare("equal", actual, expected))).toBe(false);
      expect(holds(await compare("equal", structuredClone(actual), actual))).toBe(true);
      const side = (holder: Record<string, unknown>) => (Object.hasOwn(holder, extra) ? JSON.stringify(value) : "nothing");
      expect(equalDifference(actual, expected)).toBe(`first difference at ${extra}: actual ${side(actual)}, expected ${side(expected)}`);
    }));

  it("each order compare disagrees with its negation on every pair of numbers", () =>
    hegel.testAsync(async (tc) => {
      const [first, negation] = tc.draw(gs.sampledFrom(NEGATION_PAIRS.slice(1)));
      const a = tc.draw(gs.floats({ allowNan: false, allowInfinity: false }));
      const b = tc.draw(gs.booleans()) ? a : tc.draw(gs.floats({ allowNan: false, allowInfinity: false }));
      expect(holds(await compare(first, a, b))).toBe(!holds(await compare(negation, a, b)));
    }));

  it("contains-text holds when the text holds the expected value, and breaks when it holds a letter the text has none of", () =>
    hegel.testAsync(async (tc) => {
      const before = tc.draw(gs.text({ alphabet: "ab", maxSize: 4 }));
      const after = tc.draw(gs.text({ alphabet: "ab", maxSize: 4 }));
      const needle = tc.draw(gs.text({ alphabet: "ab", minSize: 1, maxSize: 3 }));
      expect(holds(await compare("contains-text", `${before}${needle}${after}`, needle))).toBe(true);
      expect(holds(await compare("contains-text", `${before}${after}`, `${needle}c`))).toBe(false);
    }));

  it("contains-text with an expected text of only whitespace breaks, whatever the actual text", () =>
    hegel.testAsync(async (tc) => {
      const actual = tc.draw(gs.text({ alphabet: "ab \n", maxSize: 6 }));
      const blank = tc.draw(gs.text({ alphabet: " \t\n", maxSize: 3 }));
      expect(await compare("contains-text", actual, blank)).toEqual({
        reason: "contains-text has an expected text of only whitespace or nothing, which almost every string holds",
      });
    }));

  it("starts-with-text and ends-with-text hold when the text starts or ends with the expected value, and break when it holds it only further in", () =>
    hegel.testAsync(async (tc) => {
      const before = tc.draw(gs.text({ alphabet: "ab", maxSize: 4 }));
      const after = tc.draw(gs.text({ alphabet: "ab", maxSize: 4 }));
      const needle = tc.draw(gs.text({ alphabet: "ab", minSize: 1, maxSize: 3 }));
      expect(holds(await compare("starts-with-text", `${needle}${after}`, needle))).toBe(true);
      expect(holds(await compare("ends-with-text", `${before}${needle}`, needle))).toBe(true);
      expect(holds(await compare("starts-with-text", `c${needle}${after}`, needle))).toBe(false);
      expect(holds(await compare("ends-with-text", `${before}${needle}c`, needle))).toBe(false);
    }));

  it("starts-with-text and ends-with-text agree with contains-text whenever they hold", () =>
    hegel.testAsync(async (tc) => {
      const actual = tc.draw(gs.text({ alphabet: "ab", maxSize: 6 }));
      const expected = tc.draw(gs.text({ alphabet: "ab", minSize: 1, maxSize: 3 }));
      const name = tc.draw(gs.sampledFrom(["starts-with-text", "ends-with-text"] as const));
      if (holds(await compare(name, actual, expected))) expect(holds(await compare("contains-text", actual, expected))).toBe(true);
    }));

  it("starts-with-text and ends-with-text with an expected text of only whitespace break, whatever the actual text", () =>
    hegel.testAsync(async (tc) => {
      const actual = tc.draw(gs.text({ alphabet: "ab \n", maxSize: 6 }));
      const blank = tc.draw(gs.text({ alphabet: " \t\n", maxSize: 3 }));
      const name = tc.draw(gs.sampledFrom(["starts-with-text", "ends-with-text"] as const));
      expect(await compare(name, actual, blank)).toEqual({
        reason: `${name} has an expected text of only whitespace or nothing, which almost every string holds`,
      });
    }));

  it("matches holds when the text holds the pattern, and breaks when the pattern needs a letter the text has none of", () =>
    hegel.testAsync(async (tc) => {
      const text = tc.draw(gs.text({ alphabet: "ab", maxSize: 6 }));
      const piece = tc.draw(gs.text({ alphabet: "ab", minSize: 1, maxSize: 3 }));
      expect(holds(await compare("matches", `${text}${piece}`, `${piece}$`))).toBe(true);
      expect(holds(await compare("matches", text, `${piece}c`))).toBe(false);
    }));

  it("matches with a pattern that matches the empty string breaks, whatever the actual text", () =>
    hegel.testAsync(async (tc) => {
      const text = tc.draw(gs.text({ alphabet: "ab", maxSize: 6 }));
      const piece = tc.draw(gs.text({ alphabet: "ab", minSize: 1, maxSize: 3 }));
      const pattern = tc.draw(gs.sampledFrom([`(${piece})?`, `(${piece})*`, `^`, `|${piece}`, `(?:)`]));
      expect(await compare("matches", text, pattern)).toEqual({
        reason: "matches has a pattern that matches the empty string, so every string holds it",
      });
    }));

  it("has-item holds when one item equals the expected value, and breaks when none does", () =>
    hegel.testAsync(async (tc) => {
      const items = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 9 }), { maxSize: 5 }));
      const wanted = tc.draw(gs.integers({ minValue: 0, maxValue: 9 }));
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: items.length }));
      const withIt = [...items.slice(0, at), wanted, ...items.slice(at)];
      const without = items.filter((item) => item !== wanted);
      expect(holds(await compare("has-item", withIt, wanted))).toBe(true);
      expect(holds(await compare("has-item", without, wanted))).toBe(false);
    }));

  it("has-same-items holds for every reordering of an array, and only when each item appears as many times on both sides", () =>
    hegel.testAsync(async (tc) => {
      const items = tc.draw(gs.arrays(jsonValues, { maxSize: 5 }));
      const order = tc.draw(gs.arrays(gs.floats({ allowNan: false, allowInfinity: false }), { minSize: items.length, maxSize: items.length }));
      const shuffled = items.map((item, index) => ({ item, key: order[index]! })).sort((a, b) => a.key - b.key).map((entry) => entry.item);
      expect(holds(await compare("has-same-items", items, shuffled))).toBe(true);
      const other = tc.draw(gs.arrays(jsonValues, { maxSize: 5 }));
      const counts = (list: readonly unknown[], item: unknown) => list.filter((entry) => deepEqual(entry, item)).length;
      const sameCounts = other.length === items.length && [...items, ...other].every((item) => counts(items, item) === counts(other, item));
      expect(holds(await compare("has-same-items", items, other))).toBe(sameCounts);
      expect(sameItems(items, other)).toBe(sameItems(other, items));
    }));

  it("names an item by the first identity field that holds a string or a number, and an item that is no object by nothing", () =>
    hegel.test((tc) => {
      const fields = tc.draw(gs.arrays(gs.sampledFrom(["id", "name", "key", "kind", "total"]), { maxSize: 5 }));
      const item = Object.fromEntries(fields.map((field) => [field, tc.draw(jsonValues)]));
      const identity = itemIdentity(item);
      const naming = IDENTITY_FIELDS.find((field) => typeof item[field] === "string" || (typeof item[field] === "number" && Number.isFinite(item[field])));
      expect(identity).toEqual(naming === undefined ? undefined : { field: naming, value: item[naming] });
      expect(itemIdentity([item])).toBeUndefined();
      expect(itemIdentity(tc.draw(gs.oneOf<unknown>(gs.just(null), gs.text(), gs.integers())))).toBeUndefined();
    }));

  it("has-same-items does not hold when one side repeats an item the other holds once", () =>
    hegel.testAsync(async (tc) => {
      const items = tc.draw(gs.arrays(jsonValues, { minSize: 1, maxSize: 4 }));
      const repeated = tc.draw(gs.sampledFrom(items));
      expect(holds(await compare("has-same-items", [...items, repeated], items))).toBe(false);
      expect(holds(await compare("has-same-items", items, [repeated, ...items]))).toBe(false);
    }));

  /** `value` with some fields left out of each object, at every depth,
   * and every array kept at its length: what a sentence states of a
   * larger value. An object keeps at least one field when it has one. */
  function someFields(tc: hegel.TestCase, value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => someFields(tc, item));
    if (jsonType(value) !== "object") return value;
    const entries = Object.entries(value as Record<string, unknown>);
    const kept = entries.filter(() => tc.draw(gs.booleans()));
    return Object.fromEntries((kept.length === 0 ? entries.slice(0, 1) : kept).map(([key, item]) => [key, someFields(tc, item)]));
  }

  const jsonObjects = jsonValues.filter((value) => jsonType(value) === "object");

  it("has-fields holds for an object against any of its fields, at every depth, and breaks only on an expected object with no field", () =>
    hegel.testAsync(async (tc) => {
      const actual = tc.draw(jsonObjects);
      const expected = someFields(tc, actual);
      const empty = fieldlessObject(expected);
      const result = await compare("has-fields", actual, expected);
      if (empty === null) expect(holds(result)).toBe(true);
      else expect(result).toEqual({ reason: `has-fields has an expected object with no field${empty.length === 0 ? "" : ` at ${empty.join(".")}`}, which every object holds` });
    }));

  it("has-fields holds whenever equal holds, and breaks where an expected field is missing or holds another value", () =>
    hegel.testAsync(async (tc) => {
      const { root, path } = tc.draw(rootWithPath);
      tc.assume(fieldlessObject(root) === null);
      expect(holds(await compare("has-fields", root, structuredClone(root)))).toBe(true);
      const segments = path.split(".");
      const changed = structuredClone(root);
      let parent: any = changed;
      for (const segment of segments.slice(0, -1)) parent = parent[segment];
      parent[segments.at(-1)!] = "\u00a7 changed";
      tc.assume(fieldlessObject(changed) === null);
      expect(holds(await compare("has-fields", root, changed))).toBe(false);
      expect(fieldMisfit(root, changed)).toMatchObject({ kind: "differs", path: segments, expected: "\u00a7 changed" });
      const extra = { ...changed, "\u00a7": 1 };
      expect(holds(await compare("has-fields", changed, extra))).toBe(false);
      expect(fieldMisfit(changed, extra)).toEqual({ kind: "missing", path: ["\u00a7"], expected: 1 });
    }));

  it("has-fields reads an expected array as the whole list: its length and each item in order", () =>
    hegel.testAsync(async (tc) => {
      const items = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 3 }), { maxSize: 4 }));
      const other = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 3 }), { maxSize: 4 }));
      expect(holds(await compare("has-fields", { items, n: 1 }, { items: other }))).toBe(deepEqual(items, other));
      if (items.length !== other.length) expect(fieldMisfit({ items }, { items: other })).toEqual({ kind: "length", path: ["items"], actual: items.length, expected: other.length });
    }));

  /** Whether `want` fits `have` by trying every number of lines each
   * `...` could take, with each other line as an anchored regular
   * expression: slow, and plainly what fits-text means. */
  function fitsByTrying(want: readonly string[], have: readonly string[]): boolean {
    if (want.length === 0) return have.length === 0;
    const [line, ...rest] = want as [string, ...string[]];
    if (line === "...") return Array.from({ length: have.length + 1 }, (_, taken) => taken).some((taken) => fitsByTrying(rest, have.slice(taken)));
    const pattern = new RegExp(`^${line.split("[..]").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^]*")}$`);
    return have.length > 0 && pattern.test(have[0]!) && fitsByTrying(rest, have.slice(1));
  }

  const actualLine = gs.text({ alphabet: "ab\r", maxSize: 3 });
  const expectedLine = gs.oneOf<string>(
    gs.just("..."),
    gs.text({ alphabet: "ab", maxSize: 3 }),
    gs.composite((tc) => `${tc.draw(gs.text({ alphabet: "ab", maxSize: 2 }))}[..]${tc.draw(gs.text({ alphabet: "ab", maxSize: 2 }))}`),
  );

  it("fits-text agrees with trying every way the ... lines could split the actual text", () =>
    hegel.test((tc) => {
      const have = tc.draw(gs.arrays(actualLine, { maxSize: 5 }));
      const want = tc.draw(gs.arrays(expectedLine, { maxSize: 4 }));
      const actual = `${have.join("\n")}${tc.draw(gs.sampledFrom(["", "\n"]))}`;
      const expected = `${want.join("\n")}${tc.draw(gs.sampledFrom(["", "\n"]))}`;
      expect(textFit(actual, expected).fits).toBe(fitsByTrying(fitLines(expected), fitLines(actual)));
    }));

  it("fits-text holds for any text against itself, and against it with a run of lines replaced by ... or a part of a line by [..]", () =>
    hegel.testAsync(async (tc) => {
      const lines = tc.draw(gs.arrays(gs.text({ alphabet: "ab .", minSize: 1, maxSize: 6 }), { minSize: 1, maxSize: 6 }));
      const text = lines.join("\n");
      expect(textFit(text, text).fits).toBe(true);
      const start = tc.draw(gs.integers({ minValue: 0, maxValue: lines.length }));
      const end = tc.draw(gs.integers({ minValue: start, maxValue: lines.length }));
      expect(textFit(text, [...lines.slice(0, start), "...", ...lines.slice(end)].join("\n")).fits).toBe(true);
      const index = tc.draw(gs.integers({ minValue: 0, maxValue: lines.length - 1 }));
      const line = lines[index]!;
      const from = tc.draw(gs.integers({ minValue: 0, maxValue: line.length }));
      const to = tc.draw(gs.integers({ minValue: from, maxValue: line.length }));
      const globbed = lines.map((entry, at) => (at === index ? `${line.slice(0, from)}[..]${line.slice(to)}` : entry)).join("\n");
      // A generated line that is exactly "..." is a stand-in too, and a text
      // of stand-ins alone is refused, so it is not one this property covers.
      tc.assume(globbed.split("\n").some((entry) => entry !== "..." && entry.replaceAll("[..]", "").trim() !== ""));
      expect(holds(await compare("fits-text", text, globbed))).toBe(true);
    }));

  it("fits-text without ... or [..] holds exactly when the lines are equal, a final newline on either side aside", () =>
    hegel.test((tc) => {
      const have = tc.draw(gs.arrays(actualLine, { maxSize: 4 }));
      const want = tc.draw(gs.booleans()) ? [...have] : tc.draw(gs.arrays(actualLine, { maxSize: 4 }));
      const actual = `${have.join("\n")}${tc.draw(gs.sampledFrom(["", "\n"]))}`;
      const expected = `${want.join("\n")}${tc.draw(gs.sampledFrom(["", "\n"]))}`;
      expect(textFit(actual, expected).fits).toBe(deepEqual(fitLines(actual), fitLines(expected)));
    }));

  it("[..] takes any characters between the fixed parts of a line, and never takes a line break", () =>
    hegel.test((tc) => {
      const parts = tc.draw(gs.arrays(gs.text({ alphabet: "ab", maxSize: 2 }), { minSize: 2, maxSize: 4 }));
      const fillers = parts.map(() => tc.draw(gs.text({ alphabet: "abc", maxSize: 3 })));
      const line = parts.map((part, index) => (index === 0 ? part : `${fillers[index]}${part}`)).join("");
      expect(lineFits(parts.join("[..]"), line)).toBe(true);
      tc.assume(parts.slice(1).join("") !== "");
      expect(textFit(`${parts[0]}\n${parts.slice(1).join("")}`, parts.join("[..]")).fits).toBe(false);
    }));

  it("fits-text judges a 2000-line text against an expected text of many ... lines in well under a second", () => {
    const actual = Array.from({ length: 2000 }, (_, index) => `line ${index} of the log, took ${index % 97}ms`).join("\n");
    const expected = Array.from({ length: 200 }, (_, index) => `...\nline ${index * 10} of the log, took [..]ms`).join("\n");
    const started = performance.now();
    expect(textFit(actual, expected)).toMatchObject({ fits: false, fitted: 400 });
    expect(textFit(actual, `${expected}\n...`).fits).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("fits-text reads two strings, and breaks on an expected text of only whitespace, ... lines, and [..]", async () => {
    expect(await compare("fits-text", ["a"], "a")).toEqual({ reason: "fits-text reads two strings, and compares an array with a string" });
    for (const expected of ["", "\n", "...", "...\n[..]\n  ", " [..] \n..."]) {
      expect(await compare("fits-text", "anything", expected)).toEqual({
        reason: "fits-text has an expected text of only whitespace, ... lines, and [..], which almost every text holds",
      });
    }
  });

  it("fits-text reads a line break written \\r\\n as one written \\n, on either side, and any other \\r as a character", () =>
    hegel.test((tc) => {
      const have = tc.draw(gs.arrays(gs.text({ alphabet: "ab", maxSize: 3 }), { maxSize: 5 }));
      const want = tc.draw(gs.arrays(expectedLine, { maxSize: 4 }));
      const breakAt = () => tc.draw(gs.sampledFrom(["\n", "\r\n"]));
      const final = tc.draw(gs.booleans());
      const broken = (lines: readonly string[]) => `${lines.map((line, index) => (index === 0 ? line : `${breakAt()}${line}`)).join("")}${final ? breakAt() : ""}`;
      const plain = (lines: readonly string[]) => `${lines.join("\n")}${final ? "\n" : ""}`;
      expect(textFit(broken(have), broken(want))).toEqual(textFit(plain(have), plain(want)));
      tc.assume(have.length > 0);
      expect(textFit(`${have.join("\n")}\r`, have.join("\n")).fits).toBe(false);
    }));

  it("fits-text judges a 200000-line text in a time linear in its lines when the expected text has no ... line or one", () => {
    const have = Array.from({ length: 200_000 }, (_, index) => `line ${index} of the log`);
    const actual = have.join("\n");
    const changed = [...have.slice(0, 999), "line 999 of another log"];
    const started = performance.now();
    expect(textFit(actual, have.slice(0, 1000).join("\n"))).toEqual({ fits: false, fitted: 1000, at: 1001, actual: "line 1000 of the log" });
    expect(textFit(actual, changed.join("\n"))).toEqual({ fits: false, fitted: 999, expected: "line 999 of another log", at: 1000, actual: "line 999 of the log" });
    expect(textFit(actual, ["line 0 of the log", "...", ...have.slice(-1000)].join("\n")).fits).toBe(true);
    expect(textFit(actual, ["...", ...have.slice(500, 1500)].join("\n"))).toEqual({ fits: false, fitted: 1001, at: 1501, actual: "line 1500 of the log" });
    // Walking every actual line for each expected line took 25 seconds
    // here; one walk takes milliseconds, so a loaded machine stays far
    // inside the bound.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("has-fields compares two objects and names the other types it was given", async () => {
    expect(await compare("has-fields", [{ id: 1 }], { id: 1 })).toEqual({ reason: "has-fields compares two objects, and compares an array with an object" });
    expect(await compare("has-fields", { id: 1 }, "x")).toEqual({ reason: "has-fields compares two objects, and compares an object with a string" });
    expect(await compare("has-fields", { items: [{ id: 1 }] }, { items: [{}] })).toEqual({
      reason: "has-fields has an expected object with no field at items.0, which every object holds",
    });
    expect(await compare("has-fields", { id: 1 }, {})).toEqual({ reason: "has-fields has an expected object with no field, which every object holds" });
  });

  /** A kind's name as a sentence may write it: any case, spaces around. */
  const spelledKind = (tc: hegel.TestCase, kind: string): string => {
    const cased = [...kind].map((letter) => (tc.draw(gs.booleans()) ? letter.toUpperCase() : letter)).join("");
    return `${tc.draw(gs.sampledFrom(["", " "]))}${cased}${tc.draw(gs.sampledFrom(["", " \n"]))}`;
  };

  it("is-a holds for a JSON value exactly when the kind its sentence names is the value's JSON type, however the name is cased", () =>
    hegel.testAsync(async (tc) => {
      const value = tc.draw(jsonValues);
      const kind = tc.draw(gs.sampledFrom(["string", "text", "number", "integer", "boolean", "list", "array", "object", "null"]));
      const type = jsonType(value);
      const of: Record<string, boolean> = {
        string: type === "string",
        text: type === "string",
        number: type === "number",
        integer: type === "number" && Math.trunc(value as number) === value,
        boolean: type === "boolean",
        list: type === "array",
        array: type === "array",
        object: type === "object",
        null: type === "null",
      };
      expect(holds(await compare("is-a", value, spelledKind(tc, kind)))).toBe(of[kind]);
    }));

  it("is-a integer holds for a whole number and not for one with a fraction", () =>
    hegel.testAsync(async (tc) => {
      const whole = tc.draw(gs.integers({ minValue: -1e6, maxValue: 1e6 }));
      expect(holds(await compare("is-a", whole, "integer"))).toBe(true);
      expect(holds(await compare("is-a", whole + 0.5, "integer"))).toBe(false);
      expect(holds(await compare("is-a", whole + 0.5, "number"))).toBe(true);
    }));

  const hex = (count: number) => gs.text({ alphabet: "0123456789abcdefABCDEF", minSize: count, maxSize: count });

  it("is-a uuid holds for five groups of 8, 4, 4, 4, and 12 hexadecimal digits in any case, and for nothing a character away", () =>
    hegel.testAsync(async (tc) => {
      const groups = [8, 4, 4, 4, 12].map((count) => tc.draw(hex(count)));
      const id = groups.join("-");
      expect(holds(await compare("is-a", id, spelledKind(tc, "uuid")))).toBe(true);
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: id.length - 1 }));
      expect(holds(await compare("is-a", `${id.slice(0, at)}g${id.slice(at + 1)}`, "uuid"))).toBe(false);
      expect(holds(await compare("is-a", `${id}0`, "uuid"))).toBe(false);
      expect(holds(await compare("is-a", groups.join(""), "uuid"))).toBe(false);
    }));

  it("is-a date holds for YYYY-MM-DD exactly when it names a day of the calendar", () =>
    hegel.testAsync(async (tc) => {
      const year = tc.draw(gs.integers({ minValue: 1000, maxValue: 9999 }));
      const month = tc.draw(gs.integers({ minValue: 0, maxValue: 13 }));
      const day = tc.draw(gs.integers({ minValue: 0, maxValue: 32 }));
      const pad = (n: number) => String(n).padStart(2, "0");
      const date = new Date(Date.UTC(year, month - 1, day));
      const real = month >= 1 && month <= 12 && day >= 1 && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
      expect(holds(await compare("is-a", `${year}-${pad(month)}-${pad(day)}`, "date"))).toBe(real);
      expect(holds(await compare("is-a", `${year}-${month}-${day}`, "date"))).toBe(real && month >= 10 && day >= 10);
    }));

  it("is-a timestamp holds for any instant written with T, t, or a space, Z or z, and an offset of +hh:mm, +hhmm, or +hh, and not without its seconds, past the 24 hours of a day, or at a leap second", () =>
    hegel.testAsync(async (tc) => {
      const instant = new Date(tc.draw(gs.integers({ minValue: 0, maxValue: 253402300799999 }))).toISOString();
      expect(holds(await compare("is-a", instant, "timestamp"))).toBe(true);
      const two = (n: number) => String(n).padStart(2, "0");
      const [hours, minutes] = [tc.draw(gs.integers({ minValue: 0, maxValue: 23 })), tc.draw(gs.integers({ minValue: 0, maxValue: 59 }))];
      const sign = tc.draw(gs.sampledFrom(["+", "-"]));
      const offset = tc.draw(gs.sampledFrom([`${sign}${two(hours)}:${two(minutes)}`, `${sign}${two(hours)}${two(minutes)}`, `${sign}${two(hours)}`, "Z", "z"]));
      const separator = tc.draw(gs.sampledFrom(["T", "t", " "]));
      const spelled = instant.replace("T", separator).replace(/Z$/, offset);
      expect(holds(await compare("is-a", spelled, "timestamp"))).toBe(true);
      expect(holds(await compare("is-a", spelled.replace(/\.\d+/, ""), "timestamp"))).toBe(true);
      expect(holds(await compare("is-a", instant.replace(/:\d\d\.\d+Z$/, "Z"), "timestamp"))).toBe(false);
      expect(holds(await compare("is-a", instant.replace(/T\d\d/, "T24"), "timestamp"))).toBe(false);
      expect(holds(await compare("is-a", instant.replace(/:\d\d\./, ":60."), "timestamp"))).toBe(false);
      expect(holds(await compare("is-a", instant.slice(0, 10), "timestamp"))).toBe(false);
      expect(holds(await compare("is-a", instant.replace(/Z$/, ""), "timestamp"))).toBe(false);
      expect(holds(await compare("is-a", instant.replace("T", tc.draw(gs.sampledFrom(["", "_", "  ", "\n"]))), "timestamp"))).toBe(false);
      const wrongOffset = tc.draw(gs.sampledFrom([`${sign}24:00`, `${sign}${two(hours)}:60`, `${sign}${two(hours)}:`, `${sign}${two(hours)}:${minutes % 10}`, `${sign}${hours % 10}`]));
      expect(holds(await compare("is-a", instant.replace(/Z$/, wrongOffset), "timestamp"))).toBe(false);
    }));

  it("is-a url holds for an absolute http or https URL and not for another scheme, a relative path, or a text with a space, a control character, or a format character anywhere", () =>
    hegel.testAsync(async (tc) => {
      const host = tc.draw(gs.text({ alphabet: "abc", minSize: 1, maxSize: 5 }));
      const route = tc.draw(gs.text({ alphabet: "abc/", maxSize: 6 }));
      const scheme = tc.draw(gs.sampledFrom(["http", "https", "HTTPS"]));
      const url = `${scheme}://${host}.example/${route}`;
      expect(holds(await compare("is-a", url, "url"))).toBe(true);
      expect(holds(await compare("is-a", `ftp://${host}.example/${route}`, "url"))).toBe(false);
      expect(holds(await compare("is-a", `/${route}`, "url"))).toBe(false);
      expect(holds(await compare("is-a", `http:${host}.example`, "url"))).toBe(false);
      // C0 and C1 controls, and format characters a reader cannot see: a
      // zero-width space, a mark, a word joiner, a byte order mark, a soft
      // hyphen.
      const unseen = tc.draw(gs.sampledFrom([" ", "\t", "\u0000", "\u001f", "\u007f", "\u0080", "\u0085", "\u009f", "​", "‎", "⁠", "﻿", "­"]));
      const at = tc.draw(gs.integers({ minValue: scheme.length + 3, maxValue: url.length }));
      expect(holds(await compare("is-a", `${url.slice(0, at)}${unseen}${url.slice(at)}`, "url"))).toBe(false);
    }));

  it("is-a reads the name of a kind it knows, and names every kind it knows otherwise", async () => {
    expect(await compare("is-a", "x", 3)).toEqual({ reason: "is-a reads the name of a kind as a string, and the expected value is a number" });
    expect(await compare("is-a", "x", "guid")).toEqual({
      reason: `is-a names one of the kinds ${VALUE_KINDS.join(", ")}, and the expected value is "guid"`,
    });
    expect(VALUE_KINDS).toEqual(["string", "text", "number", "integer", "boolean", "list", "array", "object", "null", "uuid", "date", "timestamp", "url"]);
    expect(await compare("is-a", "x", "constructor")).toHaveProperty("reason");
  });

  it("never holds across two JSON types, and names both types", () =>
    hegel.testAsync(async (tc) => {
      const actual = tc.draw(jsonValues);
      const expected = tc.draw(jsonValues);
      tc.assume(jsonType(actual) !== jsonType(expected));
      const name = tc.draw(gs.sampledFrom(ALL_COMPARES.filter((entry) => entry !== "has-item" && entry !== "is-a" && entry !== "lacks-field")));
      const result = await compare(name, actual, expected);
      expect(result).toHaveProperty("reason");
      const reason = (result as { reason: string }).reason;
      expect(reason).toContain(jsonType(actual));
      expect(reason).toContain(jsonType(expected));
    }));

  it("has-item never holds on an array whose items are all of another type than the expected value", () =>
    hegel.testAsync(async (tc) => {
      const items = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 9 }), { minSize: 1, maxSize: 4 }));
      const expected = tc.draw(gs.oneOf<unknown>(gs.text({ alphabet: "0123456789", maxSize: 2 }), gs.booleans(), gs.just(null)));
      expect(await compare("has-item", items, expected)).toHaveProperty("reason");
      const notArray = tc.draw(gs.oneOf<unknown>(gs.text({ alphabet: "ab", maxSize: 3 }), gs.integers({ minValue: -100, maxValue: 100 }), gs.just(null)));
      expect(await compare("has-item", notArray, expected)).toHaveProperty("reason");
    }));

  it("a claim across two JSON types is broken, whichever compare it names", () =>
    hegel.testAsync(async (tc) => {
      const actual = tc.draw(jsonValues);
      const want = tc.draw(jsonValues);
      tc.assume(jsonType(actual) !== jsonType(want));
      const name = tc.draw(gs.sampledFrom(ALL_COMPARES.filter((entry) => entry !== "has-item" && entry !== "is-a" && entry !== "lacks-field")));
      const record = await judgeOne({ actual: "value", compare: name, expected: "want" }, { want }, { value: actual });
      expect(record.outcome).toBe("broken");
    }));
});

/** A value JSON cannot hold, with the words its snapshot's refusal names it by. */
const nonJsonLeaves: Generator<{ value: () => unknown; named: string }> = gs.sampledFrom([
  { value: () => Number.NaN, named: "is NaN" },
  { value: () => Number.POSITIVE_INFINITY, named: "is Infinity" },
  { value: () => 2 ** 60, named: "beyond Number.MAX_SAFE_INTEGER" },
  { value: () => 12n, named: "is the bigint 12n" },
  { value: () => () => 1, named: "is a function" },
  { value: () => Symbol("s"), named: "is a symbol" },
  { value: () => new Date(0), named: "is a Date" },
  { value: () => new Map([["a", 1]]), named: "is a Map" },
  { value: () => new (class Order {})(), named: "is an Order" },
  { value: () => Object.defineProperty({}, "a", { get: () => 1, enumerable: true }), named: ".a is a getter" },
  { value: () => Object.defineProperty({}, "a", { value: 1, enumerable: false }), named: ".a is not enumerable" },
  { value: () => ({ [Symbol("k")]: 1 }), named: "has a symbol key" },
  { value: () => [1, , 3], named: ".1 is a hole" },
  { value: () => Object.assign([1], { extra: 2 }), named: `has the key "extra" beside its items` },
  {
    value: () => {
      const cycle: Record<string, unknown> = {};
      cycle["self"] = cycle;
      return cycle;
    },
    named: ".self refers back to a value that holds it",
  },
]);

/** A JSON value with one non-JSON part put somewhere inside it. */
const valueWithNonJsonPart: Generator<{ value: unknown; named: string }> = gs.composite((tc) => {
  const leaf = tc.draw(nonJsonLeaves);
  const depth = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
  let value: unknown = leaf.value();
  for (let level = 0; level < depth; level += 1) {
    if (tc.draw(gs.booleans())) {
      const siblings = tc.draw(gs.arrays(jsonValue(1), { maxSize: 2 }));
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: siblings.length }));
      value = [...siblings.slice(0, at), value, ...siblings.slice(at)];
    } else {
      value = { ...tc.draw(gs.composite((inner) => ({ x: inner.draw(jsonValue(1)) }))), y: value };
    }
  }
  return { value, named: leaf.named };
});

describe("the plain-JSON gate", () => {
  it("lets every JSON value through unchanged, on either side", () =>
    hegel.testAsync(async (tc) => {
      const value = tc.draw(jsonValues);
      expect(snapshot(value)).toEqual({ value });
      const copy = structuredClone(value);
      const record = await judgeOne({ actual: "value", compare: "equal", expected: "want" }, { want: copy }, { value });
      expect(record).toMatchObject({ outcome: "held" });
      expect(deepEqual((record as { actual?: unknown }).actual, value)).toBe(true);
      expect(deepEqual((record as { expected?: unknown }).expected, value)).toBe(true);
    }));

  it("judges no claim with a non-JSON part on either side, names it, and records no value for that side", () =>
    hegel.testAsync(async (tc) => {
      const { value, named } = tc.draw(valueWithNonJsonPart);
      const taken = snapshot(value);
      expect("refused" in taken).toBe(true);
      const refusal = (taken as { refused: { at: string[]; problem: string } }).refused;
      expect(["v", ...refusal.at].join(".") + " " + refusal.problem).toContain(named);
      const onActual = tc.draw(gs.booleans());
      const other = tc.draw(jsonValues);
      const record = onActual
        ? await judgeOne({ actual: "value", compare: "equal", expected: "want" }, { want: other }, { value })
        : await judgeOne({ actual: "value", compare: "equal", expected: "want" }, { want: value }, { value: other });
      expect(record.outcome).toBe("unjudged");
      expect(record.reason).toContain(named);
      expect(record.reason).toContain("which is not plain JSON, so the claim was not judged: a claim judges a plain JSON copy of the value it reads");
      expect(record).not.toHaveProperty(onActual ? "actual" : "expected");
    }));
});

/** A place and a path into it, drawn over a small alphabet so collisions
 * between two draws are common. */
const segmentsGen = gs.arrays(gs.sampledFrom(["a", "b", "0", "1", "#json"]), { maxSize: 4 });
const placeGen: Generator<ClaimPlace> = gs.composite((tc) => ({
  origin: tc.draw(gs.sampledFrom(["observe", "record:3", "sentence:want"])),
  segments: tc.draw(segmentsGen),
  label: "x",
  open: false,
}));

describe("canonical places", () => {
  it("samePlace is reflexive and symmetric, and two same places overlap", () =>
    hegel.test((tc) => {
      const a = tc.draw(placeGen);
      const b = tc.draw(placeGen);
      expect(samePlace(a, a)).toBe(true);
      expect(samePlace(a, b)).toBe(samePlace(b, a));
      expect(placesOverlap(a, b)).toBe(placesOverlap(b, a));
      if (samePlace(a, b)) expect(placesOverlap(a, b)).toBe(true);
      if (a.origin !== b.origin) expect(placesOverlap(a, b)).toBe(false);
    }));

  it("a path walked in one step or in two reaches the same place, and a longer path overlaps without being the same", () =>
    hegel.test((tc) => {
      const base = tc.draw(placeGen);
      const head = tc.draw(gs.arrays(gs.sampledFrom(["a", "b", "0"]), { minSize: 1, maxSize: 2 }));
      const tail = tc.draw(gs.arrays(gs.sampledFrom(["a", "b", "0"]), { minSize: 1, maxSize: 2 }));
      const once = placeAt(base, [...head, ...tail].join("."));
      const twice = placeAt(placeAt(base, head.join(".")), tail.join("."));
      expect(samePlace(once, twice)).toBe(true);
      const shorter = placeAt(base, head.join("."));
      expect(samePlace(shorter, once)).toBe(false);
      expect(placesOverlap(shorter, once)).toBe(true);
      expect(samePlace(placeViewed(shorter, "json"), shorter)).toBe(false);
    }));

  it("a dotted actual and the same path split into actual and at read one place and record one value, whatever sits beside it", () =>
    hegel.testAsync(async (tc) => {
      const { root, path, value } = tc.draw(rootWithPath);
      const segments = path.split(".");
      if (segments.length < 2) return;
      const split = tc.draw(gs.integers({ minValue: 1, maxValue: segments.length - 1 }));
      const head = segments.slice(0, split);
      // A part that is not plain JSON beside the place read, inside the
      // value `actual` names: only the place read is taken.
      const parent = readAt(root, segments.slice(0, -1));
      const args: Record<string, unknown> = { ...(snapshot(root) as { value: Record<string, unknown> }).value, want: value };
      if ("value" in parent && typeof parent.value === "object" && parent.value !== null && !Array.isArray(parent.value) && segments.at(-1) !== "zz") {
        let holder: any = args;
        for (const segment of segments.slice(0, -1)) holder = holder[segment];
        holder.zz = new Date(0);
      }
      const fromKeys = Object.keys(root);
      const dotted = await judgeOne({ actual: path, compare: "equal", expected: "want" }, args, undefined, fromKeys);
      const { at, ...byAt } = (await judgeOne({ actual: head.join("."), at: segments.slice(split).join("."), compare: "equal", expected: "want" }, args, undefined, fromKeys)) as unknown as Record<string, unknown>;
      expect(at).toBe(segments.slice(split).join("."));
      expect(byAt).toEqual(dotted);
      expect(dotted).toMatchObject({ outcome: "held" });
    }));

  it("the any-index segment is the same as every decimal index and as no key", () =>
    hegel.test((tc) => {
      const base = tc.draw(placeGen);
      const index = tc.draw(gs.integers({ minValue: 0, maxValue: 99 }));
      const key = tc.draw(gs.text({ alphabet: "abc", minSize: 1, maxSize: 3 }));
      const any = { ...base, segments: [...base.segments, ANY_INDEX] };
      expect(samePlace(any, { ...base, segments: [...base.segments, String(index)] })).toBe(true);
      expect(samePlace(any, { ...base, segments: [...base.segments, key] })).toBe(false);
    }));

  it("a claim whose two sides spell one place two ways compares a value with itself, and is broken", () =>
    hegel.testAsync(async (tc) => {
      const { root, path } = tc.draw(rootWithPath);
      const segments = path.split(".");
      const split = tc.draw(gs.integers({ minValue: 0, maxValue: segments.length - 1 }));
      const actualPath = ["result", ...segments.slice(0, split)].join(".");
      const at = segments.slice(split).join(".");
      const record = await judgeOne(
        { actual: actualPath, at, compare: "equal", expected: { from: `result.${path}` } },
        { result: root },
        undefined,
        ["result"],
      );
      expect(record.outcome).toBe("broken");
      expect(record.reason).toMatch(/^both sides read from:produce@3\.result.*, so the claim compares a value with itself$/);
    }));
});

describe("an expected value observe received", () => {
  it("breaks a claim exactly when observe received a key from the same earlier result as the expected value, and names the key", () =>
    hegel.testAsync(async (tc) => {
      // Each from key is filled from one returns key of one producer; two
      // keys filled from "cart" read one value.
      const source = { before: "cart", now: tc.draw(gs.sampledFrom(["cart", "out"])), other: tc.draw(gs.sampledFrom(["cart", "out"])) } as const;
      const received = tc.draw(gs.sampledFrom<readonly ("now" | "other")[]>([[], ["now"], ["other"], ["now", "other"]]));
      const path = tc.draw(gs.sampledFrom(["count", "items", "items.0"]));
      const cart = { count: 1, items: [1] };
      const claim: Claim = { actual: path, compare: "equal", expected: { from: `before.${path}` } };
      const fromKeys = Object.keys(source);
      const [judged] = await evaluateClaims([claim], {
        ...inputs({ before: cart, now: cart, other: cart }, cart, fromKeys),
        argSide: (key) => {
          const returnsKey = source[key as keyof typeof source];
          return { origin: "record:produce", segments: [returnsKey], label: `from:produce@3.${returnsKey}` };
        },
        observeReceived: received,
      });
      const carrier = received.find((key) => source[key] === "cart");
      if (carrier === undefined) {
        expect(judged!.record.outcome).toBe("held");
        return;
      }
      expect(judged!.record).toMatchObject({
        outcome: "broken",
        reason: `observe received args.${carrier}, which is from:produce@3.cart, and the expected value reads from:produce@3.cart.${path}, so observe could return the value the claim compares it with`,
      });
    }));
});

describe("an actual from value observe received, compared with an observe value", () => {
  it("breaks a claim exactly when observe received a key from the same earlier result as the actual value, and names the key", () =>
    hegel.testAsync(async (tc) => {
      // The mirror of the rule above: the actual side is the from value,
      // and observe answers the expected side, so observe must not have
      // received the value the actual side reads.
      const source = { cart: "cart", other: tc.draw(gs.sampledFrom(["cart", "out"])) } as const;
      const received = tc.draw(gs.sampledFrom<readonly ("cart" | "other")[]>([[], ["cart"], ["other"], ["cart", "other"]]));
      const path = tc.draw(gs.sampledFrom(["cart", "cart.count", "cart.items.0"]));
      const cart = { count: 1, items: [1] };
      const shown = path === "cart" ? cart : 1;
      const asEach = tc.draw(gs.booleans());
      const claim: Claim = asEach
        ? { actual: "cart.items", each: { claims: [{ compare: "equal", expected: { observe: "item" } }] } }
        : { actual: path, compare: "equal", expected: { observe: "shown" } };
      const fromKeys = Object.keys(source);
      const [judged] = await evaluateClaims([claim], {
        ...inputs({ cart, other: cart }, { shown, item: 1 }, fromKeys),
        argSide: (key) => {
          const returnsKey = source[key as keyof typeof source];
          return { origin: "record:produce", segments: [returnsKey], label: `from:produce@3.${returnsKey}` };
        },
        observeReceived: received,
      });
      const carrier = received.find((key) => source[key] === "cart");
      if (carrier === undefined) {
        expect(judged!.record.outcome).toBe("held");
        return;
      }
      const reads = asEach ? "each.claims[0] reads each item of from:produce@3.cart.items" : `the actual value reads from:produce@3.${path}`;
      expect(judged!.record).toMatchObject({
        outcome: "broken",
        reason: `observe received args.${carrier}, which is from:produce@3.cart, and ${reads}, so observe could return the value the claim compares it with`,
      });
    }));
});

describe("view and at", () => {
  it("view json with at reads the value at that path of the JSON text", () =>
    hegel.testAsync(async (tc) => {
      const { root, path, value } = tc.draw(rootWithPath);
      const viewed = applyView("json", JSON.stringify(root));
      const read = "value" in viewed ? readAt(viewed.value, path.split(".")) : { missing: 0 };
      expect("value" in read && deepEqual(read.value, value)).toBe(true);
      const record = await judgeOne(
        { actual: "stdout", view: "json", at: path, compare: "equal", expected: "want" },
        { want: structuredClone(value) },
        { stdout: `${JSON.stringify(root)}\n` },
      );
      expect(record.outcome).toBe("held");
      expect(deepEqual((record as { actual?: unknown }).actual, value)).toBe(true);
    }));

  it("at a path the value does not hold breaks, and says where", () =>
    hegel.testAsync(async (tc) => {
      const { root, path } = tc.draw(rootWithPath);
      const at = `${path}.zz`;
      const record = await judgeOne(
        { actual: "stdout", view: "json", at, compare: "equal", expected: "want" },
        { want: 0 },
        { stdout: JSON.stringify(root) },
      );
      expect(record.outcome).toBe("broken");
      expect(record.reason).toBe(`observe:stdout as json has nothing at ${at}`);
      expect(record).not.toHaveProperty("actual");
    }));

  it("readAt on a path of a drawn object returns a copy of what walking the path reaches", () =>
    hegel.test((tc) => {
      const { root, path, value } = tc.draw(rootWithPath);
      const read = readAt(root, path.split("."));
      expect("value" in read && deepEqual(read.value, value)).toBe(true);
    }));

  it("view comma-list reads back the items a sentence joined with commas, whatever the spacing around each", () =>
    hegel.test((tc) => {
      const items = tc.draw(gs.arrays(gs.text({ alphabet: "ab c", minSize: 1, maxSize: 4 }).filter((item) => item.trim() === item && item !== ""), { minSize: 1, maxSize: 5 }));
      const separators = items.map(() => tc.draw(gs.sampledFrom([",", ", ", " , ", ",  "])));
      const text = items.map((item, index) => (index === 0 ? item : `${separators[index]}${item}`)).join("");
      expect(applyView("comma-list", `${tc.draw(gs.sampledFrom(["", " "]))}${text}${tc.draw(gs.sampledFrom(["", "\n"]))}`)).toEqual({ value: items });
      expect(applyView("comma-list", tc.draw(gs.text({ alphabet: " \n", maxSize: 3 })))).toEqual({ value: [] });
    }));

  it("the namespaces a sentence lists in one order hold against a drawing in another, and the record says how the line was read", async () => {
    const record = await judgeOne(
      { actual: "outlined", compare: "has-same-items", expected: "names", expected_view: "comma-list" },
      { names: "CFP, Schedule, Registration" },
      { outlined: ["Registration", "CFP", "Schedule"] },
    );
    expect(record.outcome).toBe("held");
    expect(record).toMatchObject({ expected: ["CFP", "Schedule", "Registration"], expected_from: "sentence:names as comma-list" });
    const missing = await judgeOne(
      { actual: "outlined", compare: "has-same-items", expected: "names", expected_view: "comma-list" },
      { names: "CFP, Schedule, Registration, Program" },
      { outlined: ["Registration", "CFP", "Schedule"] },
    );
    expect(missing.outcome).toBe("broken");
  });

  it("view lines at an index reads that line, whatever the line ending", () =>
    hegel.testAsync(async (tc) => {
      const lines = tc.draw(gs.arrays(gs.text({ alphabet: "ab", minSize: 1, maxSize: 4 }), { minSize: 1, maxSize: 5 }));
      const ending = tc.draw(gs.sampledFrom(["\n", "\r\n"]));
      const trailing = tc.draw(gs.sampledFrom(["", ending, `${ending}${ending}`]));
      const text = `${lines.join(ending)}${trailing}`;
      const index = tc.draw(gs.integers({ minValue: 0, maxValue: lines.length - 1 }));
      expect(applyView("lines", text)).toEqual({ value: lines });
      const record = await judgeOne(
        { actual: "stdout", view: "lines", at: String(index), compare: "equal", expected: "want" },
        { want: lines[index] },
        { stdout: text },
      );
      expect(record.outcome).toBe("held");
    }));

  it("view text ignores trailing whitespace and nothing else", () =>
    hegel.test((tc) => {
      const text = tc.draw(gs.text({ alphabet: "a b\n", maxSize: 8 }));
      const tail = tc.draw(gs.text({ alphabet: " \t\n", maxSize: 4 }));
      expect(applyView("text", `${text}${tail}`)).toEqual({ value: text.trimEnd() });
    }));

  it("a view on a value that is not a string breaks, naming the type it read", () =>
    hegel.test((tc) => {
      const value = tc.draw(jsonValues);
      tc.assume(typeof value !== "string");
      const view = tc.draw(gs.sampledFrom(["text", "lines", "json"] as const));
      expect(applyView(view, value)).toEqual({ reason: `view ${view} reads a string, and the value is ${article(jsonType(value))}` });
    }));
});

describe("count", () => {
  /** A list, and one way a claim reaches it: the value itself, the lines
   * of a text, the items of a comma list, a path inside its JSON text, or
   * a path with no view, with the label its count is recorded under. */
  const listRead = gs.composite((tc) => {
    const items = tc.draw(gs.arrays(gs.text({ alphabet: "ab", minSize: 1, maxSize: 3 }), { maxSize: 6 }));
    const reads = [
      { claim: { actual: "list" }, observation: { list: items }, label: "count of observe:list" },
      { claim: { actual: "out", view: "lines" }, observation: { out: `${items.join("\n")}\n` }, label: "count of observe:out as lines" },
      { claim: { actual: "out", view: "comma-list" }, observation: { out: items.join(", ") }, label: "count of observe:out as comma-list" },
      { claim: { actual: "out", view: "json", at: "body.list" }, observation: { out: JSON.stringify({ body: { list: items } }) }, label: "count of observe:out as json at body.list" },
      { claim: { actual: "out", at: "body.list" }, observation: { out: { body: { list: items } } }, label: "count of observe:out.body.list" },
    ] as const;
    return { items, read: tc.draw(gs.sampledFrom(reads)) };
  });

  it("is the length of the list, read as it is, as lines, as a comma list, or at a path, and the record names what was counted", () =>
    hegel.testAsync(async (tc) => {
      const { items, read } = tc.draw(listRead);
      const claim = { ...read.claim, count: true, compare: "equal", expected: "n" } as Claim;
      const held = await judgeOne(claim, { n: items.length }, read.observation);
      expect(held).toMatchObject({ actual: items.length, actual_from: read.label, count: true, outcome: "held" });
      const off = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
      const broken = await judgeOne(claim, { n: items.length + off }, read.observation);
      expect(broken).toMatchObject({ actual: items.length, outcome: "broken" });
      expect(broken).not.toHaveProperty("reason");
    }));

  it("judges with each number compare exactly as that compare judges the length", () =>
    hegel.testAsync(async (tc) => {
      const { items, read } = tc.draw(listRead);
      const name = tc.draw(gs.sampledFrom(COUNT_COMPARES));
      const bound = tc.draw(gs.integers({ minValue: -2, maxValue: 8 }));
      const record = await judgeOne({ ...read.claim, count: true, compare: name, expected: "n" } as Claim, { n: bound }, read.observation);
      expect(record.outcome).toBe(holds(await compare(name, items.length, bound)) ? "held" : "broken");
    }));

  it("breaks on a value that is not an array, naming its type, under every number compare", () =>
    hegel.testAsync(async (tc) => {
      const value = tc.draw(jsonValues);
      tc.assume(!Array.isArray(value));
      const name = tc.draw(gs.sampledFrom(COUNT_COMPARES));
      const record = await judgeOne({ actual: "v", count: true, compare: name, expected: "n" }, { n: tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) }, { v: value });
      expect(record).toMatchObject({ actual_from: "count of observe:v", outcome: "broken", reason: `count reads an array, and the value is ${article(jsonType(value))}` });
      expect(record).not.toHaveProperty("actual");
    }));

  it("of a list compared with the list itself is another value, so it breaks on the two types and never as a self-comparison", async () => {
    const record = await judgeOne({ actual: "result", count: true, compare: "equal", expected: { from: "result" } }, { result: ["a", "b"] }, undefined, ["result"]);
    expect(record).toMatchObject({ actual: 2, actual_from: "count of from:produce@3.result", expected: ["a", "b"], outcome: "broken", reason: "equal compares a number with an array" });
  });

  it("names the count before the place in nuka steps and on each item an each declares", () => {
    expect(describeClaim({ actual: "stdout", view: "json", at: "orders", count: true, compare: "at-least", expected: { literal: 1 } })).toBe("count of stdout as json at orders at-least 1");
    expect(describeClaim({ actual: "orders", each: { claims: [{ actual: "tags", count: true, compare: "at-least", expected: { literal: 1 } }] } })).toBe("each of orders: count of tags at-least 1");
  });

  it("counts inside each item, and a where clause on the same count that implies the claim breaks it", async () => {
    const orders = { orders: [{ tags: ["a"] }, { tags: [] }, { tags: ["a", "b"] }] };
    const every = await judgeOne({ actual: "orders", each: { claims: [{ actual: "tags", count: true, compare: "at-least", expected: "least" }] } }, { least: 1 }, orders);
    expect(every).toMatchObject({ outcome: "broken", each: { items: 3, selected: 3 } });
    expect((every as ClaimEachRecord).each.results.map((item) => (item.selected ? [item.outcome, item.claims[0]!.actual, item.claims[0]!.actual_from] : null))).toEqual([
      ["held", 1, "count of observe:orders.0.tags"],
      ["broken", 0, "count of observe:orders.1.tags"],
      ["held", 2, "count of observe:orders.2.tags"],
    ]);
    const implied = await judgeOne(
      { actual: "orders", each: { where: [{ actual: "tags", count: true, compare: "at-least", expected: "least" }], claims: [{ actual: "tags", count: true, compare: "greater-than", expected: "limit" }] } },
      { least: 2, limit: 1 },
      orders,
    );
    expect(implied).toMatchObject({
      outcome: "broken",
      reason: "each.where[0] selects the items whose count of tags is at-least 2, and every such item holds each.claims[0], greater-than 1, whatever the data, so the claim measures nothing",
    });
    const another = await judgeOne(
      { actual: "orders", each: { where: [{ actual: "tags", count: true, compare: "at-least", expected: "least" }], claims: [{ actual: "tags", compare: "not-equal", expected: "limit" }] } },
      { least: 1, limit: 1 },
      orders,
    );
    expect(another.reason).toBeUndefined();
  });

  describe("refused at import, where the run would judge it one way on every line", () => {
    const shape = { ...literalShape("no order is left, or three, or at least {least:int}"), argsKeys: new Set(["least", "result"]), requiredArgsKeys: new Set(["least", "result"]), stringArgs: new Set(["least"]) };
    const problem = (claim: Record<string, unknown>) => claimsProblem([{ actual: "result", ...claim } as Claim], shape);

    it("takes every number compare, and refuses every other compare, naming the ones it takes", () => {
      for (const name of CLAIM_COMPARES) {
        const found = problem({ count: true, compare: name, expected: "least" });
        if ((COUNT_COMPARES as readonly string[]).includes(name)) expect(found).toBeNull();
        else
          expect(found).toBe(
            `claims[0] counts the items of its actual value, which makes a number, and ${name} does not compare two numbers, so the claim would break on every line or hold on every line. Compare the count with equal, not-equal, greater-than, at-least, less-than, at-most`,
          );
      }
    });

    it("refuses a count that is not true, a literal that is no number, an expected_view that makes no number, and a count of a text", () => {
      expect(problem({ count: false, compare: "equal", expected: "least" })).toBe("claims[0].count must be true, or left out; got false");
      expect(problem({ count: true, compare: "equal", expected: { literal: 3 } })).toBeNull();
      expect(problem({ count: true, compare: "equal", expected: { literal: 0 } })).toBeNull();
      expect(problem({ count: true, compare: "equal", expected: { literal: "three" } })).toBe(
        'claims[0] counts the items of its actual value, which makes a number, and its expected value is the literal "three", which is never a number, so the claim always breaks. State the number in the pattern, as digits or a number word, and write it as a number literal',
      );
      expect(problem({ count: true, compare: "equal", expected: { literal: [] } })).toContain("its expected value is the literal [], which is never a number");
      expect(problem({ count: true, compare: "equal", expected: "least", expected_view: "lines" })).toBe(
        "claims[0] counts the items of its actual value, which makes a number, and its expected value is read through expected_view lines, which makes an array and never a number, so the claim always breaks. Capture the number with {int}, or leave expected_view out",
      );
      expect(problem({ count: true, compare: "equal", expected: "least", expected_view: "json" })).toBeNull();
      expect(problem({ view: "text", count: true, compare: "equal", expected: "least" })).toBe(
        "claims[0] counts the items of a value read through view text, which always makes a string and never an array, so the claim always breaks. Read the text with view lines to count its lines",
      );
      expect(problem({ view: "text", at: "0", count: true, compare: "equal", expected: "least" })).toBeNull();
      expect(problem({ each: { claims: [{ compare: "equal", expected: "least" }] }, count: true })).toBe(
        'claims[0] has the key "count", which a claim with each does not have. It has actual, view, at, each',
      );
    });
  });
});

describe("lacks-field", () => {
  /** An object whose keys and a field name come from one small alphabet,
   * so the name is often one of its keys, and its values include null. */
  const objectAndField = gs.composite((tc) => {
    const object: Record<string, unknown> = {};
    const count = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
    for (let i = 0; i < count; i += 1) object[tc.draw(gs.text({ alphabet: "ab", minSize: 1, maxSize: 2 }))] = tc.draw(jsonValues);
    return { object, field: tc.draw(gs.text({ alphabet: "ab", minSize: 1, maxSize: 2 })) };
  });

  it("holds exactly when the object has no own key of that name, whatever the key holds, null included", () =>
    hegel.testAsync(async (tc) => {
      const { object, field } = tc.draw(objectAndField);
      expect(holds(await compare("lacks-field", object, field))).toBe(!Object.hasOwn(object, field));
    }));

  it("never judges an absent field and a field set to null the same, and the broken line names the field and what it holds", () =>
    hegel.testAsync(async (tc) => {
      const { object, field } = tc.draw(objectAndField);
      const { [field]: _dropped, ...without } = object;
      const claim: Claim = { actual: "body", compare: "lacks-field", expected: "field" };
      const absent = await judgeOne(claim, { field }, { body: without });
      const present = await judgeOne(claim, { field }, { body: { ...without, [field]: null } });
      expect(absent).toMatchObject({ actual: without, outcome: "held" });
      expect(present).toMatchObject({ actual: { ...without, [field]: null }, outcome: "broken" });
      expect(present).not.toHaveProperty("reason");
      expect(claimLine(present as ClaimComparisonRecord)).toMatch(new RegExp(`broken; field ${JSON.stringify(field)} is present and holds null$`));
      expect(presentFieldDifference(without, field)).toBeNull();
    }));

  it("breaks on an actual value that is not an object, naming its type, and on a field name that is not a text", () =>
    hegel.testAsync(async (tc) => {
      const value = tc.draw(jsonValues);
      tc.assume(jsonType(value) !== "object");
      expect(await compare("lacks-field", value, "password")).toEqual({ reason: `lacks-field reads an object, and the actual value is ${article(jsonType(value))}` });
      const name = tc.draw(jsonValues);
      tc.assume(typeof name !== "string");
      expect(await compare("lacks-field", { password: 1 }, name)).toEqual({ reason: `lacks-field reads the name of a field as a string, and the expected value is ${article(jsonType(name))}` });
    }));

  it("breaks on a blank field name, which almost every object lacks", async () => {
    for (const blank of ["", " ", "\t\n"]) expect(await compare("lacks-field", { password: 1 }, blank)).toEqual({ reason: "lacks-field has a blank field name, which almost every object lacks" });
  });

  it("takes a key set to undefined as absent, as the snapshot leaves it out, and breaks when the parent object is missing instead of holding", async () => {
    const claim: Claim = { actual: "body.user", compare: "lacks-field", expected: { literal: "password" } };
    expect(await judgeOne(claim, {}, { body: { user: { name: "aki", password: undefined } } })).toMatchObject({ actual: { name: "aki" }, outcome: "held" });
    const missing = await judgeOne(claim, {}, { body: {} });
    expect(missing).toMatchObject({ actual_from: "observe:body.user", outcome: "broken" });
    expect(missing).not.toHaveProperty("actual");
  });

  it("reads the object that view json and at reach, and names the claim in nuka steps", async () => {
    const claim: Claim = { actual: "stdout", view: "json", at: "user", compare: "lacks-field", expected: { literal: "password" } };
    expect(await judgeOne(claim, {}, { stdout: '{"user":{"name":"aki"}}\n' })).toMatchObject({ actual_from: "observe:stdout as json at user", outcome: "held" });
    expect(await judgeOne(claim, {}, { stdout: '{"user":{"name":"aki","password":"x"}}\n' })).toMatchObject({ outcome: "broken" });
    expect(describeClaim(claim)).toBe('stdout as json at user lacks-field "password"');
  });

  describe("refused at import, where the run would judge it one way on every line", () => {
    const shape = { ...literalShape("the response has no password field, not one, none of {field:word}"), argsKeys: new Set(["field", "result"]), requiredArgsKeys: new Set(["field", "result"]), stringArgs: new Set(["field"]) };
    const problem = (claim: Record<string, unknown>) => claimsProblem([{ actual: "result", ...claim } as Claim], shape);

    it("takes a field the pattern names or the line captures, and refuses a literal that is no field name", () => {
      expect(problem({ compare: "lacks-field", expected: { literal: "password" } })).toBeNull();
      expect(problem({ compare: "lacks-field", expected: "field" })).toBeNull();
      expect(problem({ compare: "lacks-field", expected: { literal: 1 } })).toBe(
        "claims[0].expected is the literal 1, which is never the name of a field, and lacks-field names the field its actual object lacks, so the claim always breaks. State the field's name in the pattern's fixed words",
      );
    });

    it("refuses an expected_view that makes a list, and an actual view that never makes an object", () => {
      for (const view of ["lines", "comma-list"]) {
        expect(problem({ compare: "lacks-field", expected: "field", expected_view: view })).toBe(
          `claims[0].expected reads args.field through expected_view ${view}, which makes an array and never the name of a field, so lacks-field always breaks. Name one field, and leave expected_view out`,
        );
      }
      expect(problem({ compare: "lacks-field", expected: "field", expected_view: "json" })).toBeNull();
      for (const [view, made] of [["text", "a string"], ["lines", "an array"], ["comma-list", "an array"]]) {
        expect(problem({ view, compare: "lacks-field", expected: "field" })).toBe(
          `claims[0] reads its actual value through view ${view}, which always makes ${made} and never an object, so lacks-field always breaks. Read the text with view json, or claim a value that is an object`,
        );
        expect(problem({ view, at: "0", compare: "lacks-field", expected: "field" })).toBeNull();
      }
      expect(problem({ view: "json", compare: "lacks-field", expected: "field" })).toBeNull();
      expect(problem({ count: true, compare: "lacks-field", expected: "field" })).toContain("and lacks-field does not compare two numbers");
    });

    it("lets a where clause select the items that lack a field the pattern names, and judge another field of theirs", () => {
      const where = { compare: "lacks-field", expected: { literal: "password" } };
      const each = (claims: readonly Record<string, unknown>[], selector: Record<string, unknown> = where) => problem({ each: { where: [selector], claims } });
      expect(each([{ actual: "name", compare: "equal", expected: "field" }])).toBeNull();
      expect(each([{ actual: "password", compare: "equal", expected: "field" }])).toBe(
        'claims[0].each.where[0] selects by the item at password with lacks-field, and claims[0].each.claims[0] reads the item at password, the same place, so where selects the items by the value the claim then judges and "every item" says nothing. Select by another value, or drop where',
      );
      expect(each([{ compare: "lacks-field", expected: { literal: "password" } }])).toContain("selects by the item at password with lacks-field, and claims[0].each.claims[0] reads the item at password, the same place");
      expect(each([{ compare: "lacks-field", expected: { literal: "none" } }])).toBeNull();
      expect(each([{ compare: "has-fields", expected: "field", expected_view: "json" }])).toContain("reads the item itself, a place that holds it");
      // A field the line fills is not known before it binds, so the where
      // clause reads its whole item.
      expect(each([{ actual: "name", compare: "equal", expected: "field" }], { compare: "lacks-field", expected: "field" })).toContain(
        "selects by the item itself with lacks-field, and claims[0].each.claims[0] reads the item at name, a place inside it",
      );
    });
  });
});

function literalShape(pattern: string): ClaimStepShape {
  return {
    patterns: [pattern],
    argsKeys: null,
    requiredArgsKeys: null,
    fromKeys: new Set(["result"]),
    captureKeys: new Set(),
    hasObserve: false,
    rewrittenArgs: new Map(),
    stringArgs: null,
  };
}

const patternWords = gs.arrays(gs.text({ alphabet: "abc", minSize: 1, maxSize: 4 }), { minSize: 1, maxSize: 5 });

describe("the literal rule", () => {
  it("refuses a literal whose words the pattern does not hold", () =>
    hegel.test((tc) => {
      const words = tc.draw(patternWords);
      const capture = tc.draw(gs.booleans()) ? " {value}" : "";
      const pattern = `${words.join(" ")}${capture}`;
      const literal = tc.draw(
        gs.oneOf<string | number | boolean | null>(
          gs.text({ alphabet: "xyz", minSize: 1, maxSize: 4 }),
          gs.integers({ minValue: -100, maxValue: 100 }),
          gs.booleans(),
          gs.just(null),
        ),
      );
      expect(literalStatedBy(pattern, literal)).toBeNull();
      const problem = claimsProblem([{ actual: "result", compare: "equal", expected: { literal } }], literalShape(pattern));
      expect(problem).toBe(
        `claims[0].expected is the literal ${JSON.stringify(literal)}, and no fixed word of "${pattern}" states it. Put the value in the sentence, as fixed words or as a capture the claim names`,
      );
    }));

  it("refuses a literal whose word is inside a capture, an optional group, or an alternation", () =>
    hegel.test((tc) => {
      const words = tc.draw(patternWords);
      const literal = tc.draw(gs.text({ alphabet: "xyz", minSize: 1, maxSize: 4 }));
      const other = tc.draw(gs.text({ alphabet: "xyz", minSize: 1, maxSize: 4 }));
      const hidden = tc.draw(gs.sampledFrom([`(${literal})`, `${literal}/${other}`, `${other}/${literal}`, `{${literal}}`]));
      const pattern = `${words.join(" ")} ${hidden}`;
      expect(literalStatedBy(pattern, literal)).toBeNull();
      expect(claimsProblem([{ actual: "result", compare: "equal", expected: { literal } }], literalShape(pattern))).not.toBeNull();
    }));

  it("accepts a literal that is a run of the pattern's fixed words", () =>
    hegel.test((tc) => {
      const words = tc.draw(patternWords);
      const start = tc.draw(gs.integers({ minValue: 0, maxValue: words.length - 1 }));
      const end = tc.draw(gs.integers({ minValue: start + 1, maxValue: words.length }));
      const literal = words.slice(start, end).join(" ");
      expect(literalStatedBy(words.join(" "), literal)).toBe(literal);
      expect(claimsProblem([{ actual: "result", compare: "equal", expected: { literal } }], literalShape(words.join(" ")))).toBeNull();
    }));
});

describe("the literal rule, exactly", () => {
  it("refuses a run of the pattern's words written with other spacing or edge punctuation", () =>
    hegel.test((tc) => {
      const words = tc.draw(patternWords);
      const start = tc.draw(gs.integers({ minValue: 0, maxValue: words.length - 1 }));
      const end = tc.draw(gs.integers({ minValue: start + 1, maxValue: words.length }));
      const run = words.slice(start, end);
      const changed = tc.draw(
        gs.sampledFrom([`${run.join(" ")}.`, ` ${run.join(" ")}`, `${run.join(" ")} `, `"${run.join(" ")}"`, run.join("  "), run.join("\t")]),
      );
      tc.assume(changed !== run.join(" "));
      const pattern = `${words.join(" ")}.`;
      expect(literalStatedBy(pattern, changed)).toBeNull();
      expect(claimsProblem([{ actual: "result", compare: "equal", expected: { literal: changed } }], literalShape(pattern))).not.toBeNull();
      expect(literalStatedBy(pattern, run.join(" "))).toBe(run.join(" "));
    }));

  it("accepts a value the word table fixes with equal alone, and with not-equal alone when the fixed word right before it is not", () =>
    hegel.test((tc) => {
      const [word, values] = tc.draw(gs.sampledFrom(Object.entries(LITERAL_WORDS)));
      const literal = tc.draw(gs.sampledFrom(values));
      // A "not" that a capture or an optional group separates or makes
      // optional is not the line saying "not": those patterns take equal.
      const negated = tc.draw(gs.booleans());
      const pattern = negated
        ? tc.draw(gs.sampledFrom([`the list is not ${word}`, `NOT ${word} is left`, `it is not, ${word}`]))
        : tc.draw(gs.sampledFrom([`${word} item is left`, `the list is ${word}`, `the list is not {x:string} ${word}`, `the list is (not) ${word}`, `not one is ${word}`]));
      const allowed = negated ? "not-equal" : "equal";
      const compare = tc.draw(gs.sampledFrom(ALL_COMPARES));
      const problem = claimsProblem([{ actual: "result", compare, expected: { literal } }], literalShape(pattern));
      if (compare === allowed) expect(problem).toBeNull();
      else expect(problem).toBe(
        `claims[0].expected is the literal ${JSON.stringify(literal)}, which the ${negated ? `words "not ${word}" rule out` : `word "${word}" fixes`}, and claims[0].compare is "${compare}". A value a word fixes is compared with equal alone, or with not-equal alone right after the word \"not\", \"neither\", or \"nor\" (\"is not empty\"): another compare against it holds for nearly anything, and the word does not show it`,
      );
    }));

  it("a fixed number word states its number under any compare, and states no other number", () =>
    hegel.test((tc) => {
      const words = tc.draw(patternWords);
      const value = tc.draw(gs.integers({ minValue: 0, maxValue: NUMBER_WORDS.length - 1 }));
      const spelled = tc.draw(gs.sampledFrom([NUMBER_WORDS[value]!, NUMBER_WORDS[value]!.toUpperCase(), `${NUMBER_WORDS[value]!},`]));
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: words.length }));
      const pattern = [...words.slice(0, at), spelled, ...words.slice(at)].join(" ");
      const compare = tc.draw(gs.sampledFrom(["equal", "not-equal", "greater-than", "at-least", "less-than", "at-most"] as const));
      expect(claimsProblem([{ actual: "result", compare, expected: { literal: value } }], literalShape(pattern))).toBeNull();
      expect(literalStatedBy(pattern, value)?.toLowerCase()).toBe(NUMBER_WORDS[value]);
      const other = tc.draw(gs.integers({ minValue: -3, maxValue: 20 }));
      tc.assume(other !== value);
      expect(literalStatedBy(pattern, other)).toBeNull();
      expect(literalStatedBy(pattern, String(value))).toBeNull();
    }));

  it("a number word inside a capture, an optional group, or an alternation states nothing", () => {
    for (const pattern of ["at least {three} points", "at least (three) points", "at least two/three points"]) {
      expect(literalStatedBy(pattern, 3)).toBeNull();
    }
  });

  it("the adopters' sentences state their numbers in words", () => {
    expect(literalStatedBy("a relationship path follows at least three routed points", 3)).toBe("three");
    expect(literalStatedBy("one relation line was drawn throughout and none faded", 1)).toBe("one");
    expect(literalStatedBy("one relation line was drawn throughout and none faded", 0)).toBe("none");
  });

  it("neither fixes the values no fixes, so a line about two hosts can state an empty list", () => {
    const pattern = "neither host path links to it any more";
    expect(LITERAL_WORDS["neither"]).toEqual(LITERAL_WORDS["no"]);
    expect(literalStatedBy(pattern, [])).toBe("neither");
    expect(claimsProblem([{ actual: "result", compare: "equal", expected: { literal: [] } }], literalShape(pattern))).toBeNull();
  });

  it("a neither that a nor follows states nothing, and neither or nor right before a table word negates it as not does", () =>
    hegel.test((tc) => {
      const [word, values] = tc.draw(gs.sampledFrom(Object.entries(LITERAL_WORDS).filter(([entry]) => entry !== "neither")));
      const literal = tc.draw(gs.sampledFrom(values));
      const plain = tc.draw(gs.sampledFrom(["blank", "whitespace", "stale", "late"]));
      const negating = tc.draw(gs.sampledFrom(["neither", "nor", "Neither", "NOR"]));
      const negated = negating.toLowerCase() === "neither" ? `the reply is ${negating} ${word} nor ${plain}` : `the reply is neither ${plain} ${negating} ${word}`;
      expect(literalStatement(negated, literal)).toMatchObject({ words: word, compare: "not-equal", negatedBy: negating });
      expect(claimsProblem([{ actual: "result", compare: "equal", expected: { literal } }], literalShape(negated))).not.toBeNull();
      expect(claimsProblem([{ actual: "result", compare: "not-equal", expected: { literal } }], literalShape(negated))).toBeNull();
      const denied = `the reply is neither ${plain} nor ${tc.draw(gs.sampledFrom(["stale", "late", "short"]))}`;
      for (const value of LITERAL_WORDS["neither"]!) {
        expect(literalStatement(denied, value)).toBeNull();
        expect(claimsProblem([{ actual: "result", compare: "equal", expected: { literal: value } }], literalShape(denied))).not.toBeNull();
      }
    }));

  it("refuses a table literal under every compare when one pattern says the word and another says not the word", () => {
    const shape = { ...literalShape("the list is empty"), patterns: ["the list is empty", "the list is not empty"] };
    for (const compare of ["equal", "not-equal"] as const) {
      expect(claimsProblem([{ actual: "result", compare, expected: { literal: [] } }], shape)).not.toBeNull();
    }
  });
});

describe("where", () => {
  const shape = { ...literalShape("every row is at least {least:int}"), argsKeys: new Set(["least", "limit", "result"]), requiredArgsKeys: new Set(["least", "limit", "result"]) };
  const segmentsGen = gs.arrays(gs.sampledFrom(["a", "b", "c"]), { maxSize: 3 });

  /** `segments` written as an item claim, the split between `actual` and
   * `at` drawn, and a `view` drawn: three spellings of one path. */
  function spelled(tc: { draw: <T>(generator: Generator<T>) => T }, segments: readonly string[], compare: ClaimCompare, expected: string) {
    const split = tc.draw(gs.integers({ minValue: 0, maxValue: segments.length }));
    const actual = segments.slice(0, split).join(".");
    const at = segments.slice(split).join(".");
    // defineStep refuses lacks-field on a text with no at after it, which is
    // never an object.
    const view = tc.draw(gs.sampledFrom(compare === "lacks-field" && at === "" ? ([undefined, "json"] as const) : ([undefined, "text", "json"] as const)));
    // defineStep refuses has-fields on a sentence key it does not read as JSON.
    const read = compare === "has-fields" ? { expected_view: "json" as const } : {};
    return { ...(actual === "" ? {} : { actual }), ...(at === "" ? {} : { at }), ...(view === undefined ? {} : { view }), compare, expected, ...read };
  }

  const decides = ["equal", "has-same-items", "has-fields", "lacks-field", "fits-text", "is-a", "contains-text", "starts-with-text", "ends-with-text", "matches", "has-item"] as const;
  const leaves = ["greater-than", "at-least", "less-than", "at-most", "not-equal"] as const;

  it("sorts every compare into one that a where clause may not use on an overlapping place, or one the run judges", () => {
    expect([...decides, ...leaves].sort()).toEqual([...CLAIM_COMPARES].sort());
  });

  it("refuses a where clause whose place overlaps an item claim's when it compares with equal, has-same-items, has-fields, lacks-field, fits-text, is-a, a text compare, matches, or has-item, however actual, at, and view spell the places", () =>
    hegel.test((tc) => {
      const wherePath = tc.draw(segmentsGen);
      const itemPath = tc.draw(gs.booleans()) ? [...wherePath, ...tc.draw(segmentsGen)].slice(0, tc.draw(gs.integers({ minValue: 0, maxValue: 4 }))) : tc.draw(segmentsGen);
      const whereCompare = tc.draw(gs.sampledFrom([...decides, ...leaves]));
      const where = spelled(tc, wherePath, whereCompare, "least");
      const item = spelled(tc, itemPath, tc.draw(gs.sampledFrom(["equal", "at-least", "not-equal"] as const)), tc.draw(gs.sampledFrom(["least", "limit"])));
      const problem = claimsProblem([{ actual: "result", each: { where: [where], claims: [item] } }], shape);
      const overlap = itemPathsOverlap(wherePath, itemPath);
      expect(overlap).toBe(itemPathsOverlap(itemPath, wherePath));
      if (!overlap || !(decides as readonly string[]).includes(whereCompare)) {
        expect(problem).toBeNull();
        return;
      }
      const name = (segments: readonly string[]) => (segments.length === 0 ? "the item itself" : `the item at ${segments.join(".")}`);
      const relation = itemPath.length === wherePath.length ? "the same place" : itemPath.length > wherePath.length ? "a place inside it" : "a place that holds it";
      expect(problem).toBe(
        `claims[0].each.where[0] selects by ${name(wherePath)} with ${whereCompare}, and claims[0].each.claims[0] reads ${name(itemPath)}, ${relation}, so where selects the items by the value the claim then judges and "every item" says nothing. Select by another value, or drop where`,
      );
    }));

  it("overlap is symmetric, and holds exactly when one path starts the other", () =>
    hegel.test((tc) => {
      const a = tc.draw(segmentsGen);
      const b = tc.draw(segmentsGen);
      const starts = (x: readonly string[], y: readonly string[]) => x.length <= y.length && x.every((segment, index) => segment === y[index]);
      expect(itemPathsOverlap(a, b)).toBe(itemPathsOverlap(b, a));
      expect(itemPathsOverlap(a, b)).toBe(starts(a, b) || starts(b, a));
    }));

  /** A where clause and an item claim on one number, `n`, with their
   * bounds, and items drawn around them. */
  const orderPair = gs.composite((tc) => ({
    where: tc.draw(gs.sampledFrom(leaves)),
    whereBound: tc.draw(gs.integers({ minValue: -5, maxValue: 5 })),
    claim: tc.draw(gs.sampledFrom(leaves)),
    claimBound: tc.draw(gs.integers({ minValue: -5, maxValue: 5 })),
    items: tc.draw(gs.arrays(gs.integers({ minValue: -8, maxValue: 8 }), { minSize: 1, maxSize: 6 })),
  }));

  /** Whether `value <compare> bound` holds. */
  const holds = (compare: ClaimCompare, value: number, bound: number): boolean =>
    compare === "greater-than" ? value > bound : compare === "at-least" ? value >= bound : compare === "less-than" ? value < bound : compare === "at-most" ? value <= bound : value !== bound;

  it("the skill lists every compare a where clause is refused with on an item claim's place, and no other", () => {
    // The reference is how an agent learns which where clauses check
    // refuses; a compare missing from its list reads as one the run judges.
    const refused = CLAIM_COMPARES.filter((compare) =>
      (claimsProblem([{ actual: "result", each: { where: [{ actual: "a", compare, expected: "least", ...(compare === "has-fields" ? { expected_view: "json" } : {}) }], claims: [{ actual: "a", compare: "at-least", expected: "least" }] } }], shape) ?? "").includes("so where selects the items by the value the claim then judges"),
    );
    const reference = readFileSync(path.join(repoRoot, "skills/nukadoko/references/checking-steps.md"), "utf8").replace(/\s+/g, " ");
    const listed = /is refused with ([^.]*?), and breaks the claim where it implies it/.exec(reference)?.[1];
    expect(listed).toBeDefined();
    expect([...listed!.matchAll(/`([a-z-]+)`/g)].map((match) => match[1]).sort()).toEqual([...refused].sort());
  });

  it("whereImplies is true for a pair in one order direction, or two not-equal, exactly when every number the where clause selects holds the claim, and false for any other pair", () =>
    hegel.test((tc) => {
      const pair = tc.draw(orderPair);
      // Over the integers and the halves between them, which separate
      // every bound the draw can make.
      const values: number[] = [];
      for (let doubled = -24; doubled <= 24; doubled += 1) values.push(doubled / 2);
      const everySelectedHolds = values.every((value) => !holds(pair.where, value, pair.whereBound) || holds(pair.claim, value, pair.claimBound));
      const direction = (compare: ClaimCompare) => (compare === "greater-than" || compare === "at-least" ? "up" : compare === "not-equal" ? "not" : "down");
      const implied = whereImplies(pair.where, pair.whereBound, pair.claim, pair.claimBound);
      expect(implied).toBe(direction(pair.where) === direction(pair.claim) ? everySelectedHolds : false);
    }));

  it("an implied pair on one place always breaks, and a pair it does not imply is judged on the data", () =>
    hegel.testAsync(async (tc) => {
      const pair = tc.draw(orderPair);
      const claim: Claim = {
        actual: "result",
        each: { where: [{ actual: "n", compare: pair.where, expected: "least" }], claims: [{ actual: "n", compare: pair.claim, expected: "limit" }] },
      };
      expect(claimsProblem([claim], shape)).toBeNull();
      const rows = pair.items.map((n) => ({ n }));
      const record = await judgeOne(claim, { least: pair.whereBound, limit: pair.claimBound, result: rows }, undefined, ["result"]);
      if (whereImplies(pair.where, pair.whereBound, pair.claim, pair.claimBound)) {
        expect(record).toMatchObject({
          outcome: "broken",
          reason: `each.where[0] selects the items whose n is ${pair.where} ${pair.whereBound}, and every such item holds each.claims[0], ${pair.claim} ${pair.claimBound}, whatever the data, so the claim measures nothing`,
          each: { items: rows.length, selected: 0, results: [] },
        });
        return;
      }
      const selected = pair.items.filter((n) => holds(pair.where, n, pair.whereBound));
      const expected = selected.length > 0 && selected.every((n) => holds(pair.claim, n, pair.claimBound)) ? "held" : "broken";
      expect(record.outcome).toBe(expected);
      expect(record).toMatchObject({ each: { items: rows.length, selected: selected.length } });
    }));
});

describe("a value the line states", () => {
  it("refuses a claim step with no observe exactly when a capture is read by no claim, as an expected value or in where, and never one with observe", () =>
    hegel.test((tc) => {
      const keys = ["a", "b", "c"];
      const captured = new Set(tc.draw(gs.arrays(gs.sampledFrom(keys), { maxSize: 3 })));
      const named = tc.draw(gs.arrays(gs.sampledFrom(keys), { minSize: 1, maxSize: 3 }));
      const inWhere = tc.draw(gs.booleans());
      const hasObserve = tc.draw(gs.booleans());
      // A step with observe has a claim that reads it, or it is refused for that.
      const claims: Claim[] = [
        ...(inWhere
          ? [{ actual: "result", each: { where: named.map((key) => ({ actual: "n", compare: "at-least" as const, expected: key })), claims: [{ actual: "m", compare: "at-least" as const, expected: named[0]! }] } }]
          : named.map((key) => ({ actual: "result", compare: "equal" as const, expected: key }))),
        ...(hasObserve ? [{ actual: "seen", compare: "equal" as const, expected: named[0]! }] : []),
      ];
      const shape: ClaimStepShape = { ...literalShape(`the result is ${[...captured].map((key) => `{${key}}`).join(" ")}`), captureKeys: captured, hasObserve };
      const problem = claimsProblem(claims, shape);
      const unread = [...captured].find((key) => !named.includes(key));
      if (hasObserve || unread === undefined) expect(problem).toBeNull();
      else expect(problem).toBe(`the pattern captures "${unread}", and no claim reads it, and the step has no observe to receive it, so nothing checks the value the line states. Compare a claim with "${unread}", or take it out of the pattern`);
      expect(claimArgKeysRead(claims)).toEqual(new Set(["result", ...named, ...(hasObserve ? ["seen"] : [])]));
    }));
});

describe("an observe no claim reads", () => {
  const observeShape = (fromKeys: readonly string[]): ClaimStepShape => ({ ...literalShape("the value is {want}"), fromKeys: new Set(fromKeys), hasObserve: true, captureKeys: new Set(["want"]) });

  it("is refused exactly when every actual is a from key and no expected value is observe", () =>
    hegel.test((tc) => {
      const fromKeys = ["a", "b"];
      const actuals = tc.draw(gs.arrays(gs.sampledFrom(["a", "b", "c"]), { minSize: 1, maxSize: 3 }));
      const observeExpected = tc.draw(gs.booleans());
      const claims: Claim[] = actuals.map((actual, index) => ({
        actual,
        compare: "equal" as const,
        expected: observeExpected && index === 0 ? { observe: "other" } : "want",
      }));
      const problem = claimsProblem(claims, observeShape(fromKeys));
      const reads = actuals.some((actual) => !fromKeys.includes(actual)) || observeExpected;
      if (reads) expect(problem).toBeNull();
      else expect(problem).toBe(
        "the step has observe, and no claim reads what it returns: every claim's actual is a key of from, and no expected value is { observe }. " +
          "A key observe returns under a from key's name never reaches a claim, since the from value wins. " +
          "Rename the key observe returns so no from key has its name, or drop observe",
      );
    }));
});

describe("an actual from key observe also returned", () => {
  it("breaks the claim that reads it, names the key, and judges the others", async () => {
    const claims: Claim[] = [
      { actual: "sections", compare: "equal", expected: "want" },
      { actual: "gate", compare: "equal", expected: "want" },
    ];
    const judged = await evaluateClaims(claims, { ...inputs({ want: "ok", sections: "ok" }, { sections: "ok", gate: "ok" }, ["sections"]), shadowedByObserve: new Set(["sections"]) });
    expect(judged.map((entry) => entry.record.outcome)).toEqual(["broken", "held"]);
    expect(judged[0]!.record.reason).toBe(
      'observe returned "sections", and from has a key of the same name, so actual "sections" reads the from value and never what observe returned. Rename the key observe returns, or the from key, so each name has one source',
    );
  });
});

describe("each", () => {
  const itemClaims = [{ actual: "n", compare: "at-least", expected: "least" }] as const;

  it("an empty array is always broken, whatever the item claims say", () =>
    hegel.testAsync(async (tc) => {
      const least = tc.draw(gs.integers({ minValue: -10, maxValue: 10 }));
      const withWhere = tc.draw(gs.booleans());
      const where = withWhere ? { where: [{ actual: "n", compare: "less-than", expected: "least" }] as const } : {};
      const record = await judgeOne({ actual: "rows", each: { ...where, claims: itemClaims } }, { least, rows: [] }, undefined, ["rows"]);
      const declared = (compare: string) => ({ actual: "n", compare, expected: least, expected_from: "sentence:least", expected_text: "text of least" });
      expect(record).toEqual({
        actual_from: "from:produce@3.rows",
        each: { ...(withWhere ? { where: [declared("less-than")] } : {}), claims: [declared("at-least")], items: 0, selected: 0, results: [] },
        outcome: "broken",
        reason: "the array is empty, and a claim on every item of nothing measures nothing",
      });
    }));

  it("a where that selects no item is always broken, and records why each item was left out", () =>
    hegel.testAsync(async (tc) => {
      const rows = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 9 }).map((n) => ({ n })), { minSize: 1, maxSize: 6 }));
      const limit = tc.draw(gs.integers({ minValue: 9, maxValue: 100 }));
      const record = await judgeOne(
        // at-most: a claim the where clause does not imply, so the items
        // are judged.
        { actual: "rows", each: { where: [{ actual: "n", compare: "greater-than", expected: "limit" }], claims: [{ actual: "n", compare: "at-most", expected: "least" }] } },
        { least: 0, limit, rows },
        undefined,
        ["rows"],
      );
      expect(record.outcome).toBe("broken");
      expect(record).toMatchObject({ each: { items: rows.length, selected: 0 } });
      const results = (record as unknown as { each: { results: { index: number; selected: boolean; where: { outcome: string }[] }[] } }).each.results;
      expect(results.map((entry) => entry.index)).toEqual(rows.map((_, index) => index));
      expect(results.every((entry) => !entry.selected && entry.where[0]!.outcome === "broken")).toBe(true);
      expect(record.reason).toBe(
        `where selected none of the ${rows.length} items, and a claim on none of them measures nothing`,
      );
    }));

  it("holds exactly when every selected item holds", () =>
    hegel.testAsync(async (tc) => {
      const rows = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 9 }).map((n) => ({ n })), { minSize: 1, maxSize: 6 }));
      const least = tc.draw(gs.integers({ minValue: 0, maxValue: 9 }));
      const record = await judgeOne({ actual: "rows", each: { claims: itemClaims } }, { least, rows }, undefined, ["rows"]);
      expect(record.outcome).toBe(rows.every((row) => row.n >= least) ? "held" : "broken");
    }));

  it("records every item with whether where selected it, and judges exactly the selected ones", () =>
    hegel.testAsync(async (tc) => {
      const rows = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 9 }).map((n) => ({ n })), { minSize: 1, maxSize: 8 }));
      const limit = tc.draw(gs.integers({ minValue: 0, maxValue: 9 }));
      const least = tc.draw(gs.integers({ minValue: 0, maxValue: 9 }));
      const record = await judgeOne(
        { actual: "rows", each: { where: [{ actual: "n", compare: "at-most", expected: "limit" }], claims: itemClaims } },
        { least, limit, rows },
        undefined,
        ["rows"],
      );
      type Item = { index: number; selected: boolean; where: { outcome: string; actual_from: string }[]; claims?: { outcome: string }[] };
      const each = (record as unknown as { each: { selected: number; results: Item[] } }).each;
      const chosen = rows.flatMap((row, index) => (row.n <= limit ? [index] : []));
      expect(each.results.map((entry) => entry.index)).toEqual(rows.map((_, index) => index));
      expect(each.results.filter((entry) => entry.selected).map((entry) => entry.index)).toEqual(chosen);
      expect(each.selected).toBe(chosen.length);
      for (const entry of each.results) {
        expect(entry.where).toHaveLength(1);
        expect(entry.where[0]!.actual_from).toBe(`from:produce@3.rows.${entry.index}.n`);
        expect(entry.where[0]!.outcome).toBe(entry.selected ? "held" : "broken");
        expect(entry.claims === undefined).toBe(!entry.selected);
      }
      const expected = chosen.length === 0 ? "broken" : chosen.every((index) => rows[index]!.n >= least) ? "held" : "broken";
      expect(record.outcome).toBe(expected);
    }));

  it("a where claim that cannot compare an item breaks the whole claim, naming the item", async () => {
    const record = await judgeOne(
      { actual: "rows", each: { where: [{ actual: "n", compare: "at-most", expected: "limit" }], claims: itemClaims } },
      { least: 0, limit: 5, rows: [{ n: 1 }, { n: "two" }, { n: 3 }] },
      undefined,
      ["rows"],
    );
    expect(record.outcome).toBe("broken");
    expect(record.reason).toBe("where could not compare item 1: at-most compares two numbers, and compares a string with a number");
  });
});

/** A clock that only moves when the poll sleeps. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}

type Kind = "holds" | "fails" | "throws";

function readingsOf(kinds: readonly Kind[]): { read: () => Promise<Reading>; seen: Kind[] } {
  const seen: Kind[] = [];
  return {
    seen,
    read: async () => {
      const kind = kinds[seen.length] ?? "fails";
      seen.push(kind);
      return kind === "throws" ? { ok: false, error: new Error("not there yet") } : { ok: true, value: kind === "holds" };
    },
  };
}

describe("poll", () => {
  const kinds = gs.arrays(gs.sampledFrom<Kind>(["holds", "fails", "throws"]), { maxSize: 30 });
  const timeouts = gs.integers({ minValue: 1, maxValue: 2000 });

  it("passes only on two consecutive readings that hold, and never on one alone", () =>
    hegel.testAsync(async (tc) => {
      const sequence = tc.draw(kinds);
      const timeout = tc.draw(timeouts);
      const { read, seen } = readingsOf(sequence);
      const result = await pollReadings(read, async (value) => value === true, timeout, fakeClock());
      expect(result.attempts).toBe(seen.length);
      const passed = result.last.ok && result.last.value === true;
      if (passed) {
        expect(result.attempts).toBeGreaterThanOrEqual(2);
        expect(seen.slice(-2)).toEqual(["holds", "holds"]);
        // The pass is the first pair: no earlier pair of holds was ignored.
        const firstPair = seen.findIndex((kind, index) => kind === "holds" && seen[index + 1] === "holds");
        expect(firstPair).toBe(seen.length - 2);
      } else {
        expect(seen.some((kind, index) => kind === "holds" && seen[index + 1] === "holds")).toBe(false);
      }
    }));

  it("stops reading once the deadline passes, with at most one confirming reading after it", () =>
    hegel.testAsync(async (tc) => {
      const sequence = tc.draw(kinds);
      const timeout = tc.draw(timeouts);
      const { read } = readingsOf(sequence);
      const result = await pollReadings(read, async (value) => value === true, timeout, fakeClock());
      expect(result.attempts).toBeLessThanOrEqual(Math.ceil(timeout / POLL_INTERVAL_MS) + 2);
    }));

  it("reads exactly twice when every reading holds", () =>
    hegel.testAsync(async (tc) => {
      const timeout = tc.draw(timeouts);
      const result = await pollReadings(async () => ({ ok: true, value: 1 }), async (value) => value === 1, timeout, fakeClock());
      expect(result.attempts).toBe(2);
    }));
});

describe("judging is bounded by one budget", () => {
  const LIMIT = "a test's budget";
  const claims: Claim[] = [
    { actual: "lines", each: { claims: [{ compare: "matches", expected: "re" }] } },
    { actual: "count", compare: "equal", expected: "n" },
  ];

  /** Judges `claims` over `count` lines on a clock that the pattern of
   * line `stopAt` runs out, as a pattern stopped by its timer does. */
  async function judgeWithStop(count: number, stopAt: number | null) {
    let now = 0;
    const timeouts: number[] = [];
    const budget = judgingBudget(100, LIMIT, () => now);
    const lines = Array.from({ length: count }, (_, index) => `line ${index}`);
    const judged = await evaluateClaims(claims, {
      ...inputs({ re: "line", n: 0 }, { lines, count: 0 }),
      budget,
      testPattern: async (_pattern, text, timeoutMs, limit) => {
        timeouts.push(timeoutMs);
        if (text === `line ${stopAt}`) {
          now = 100;
          return { stopped: `matches did not finish within ${timeoutMs}ms (${limit}), so nukadoko stopped the pattern` };
        }
        now += 1;
        return { holds: true, matchesEmpty: false };
      },
    });
    return { records: judged.map((entry) => entry.record), timeouts };
  }

  it("never tests a pattern with no time left, stops at the first pattern that ran out, and names how many items and claims were not judged", () =>
    hegel.testAsync(async (tc) => {
      const count = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
      const stopAt = tc.draw(gs.oneOf<number | null>(gs.just(null), gs.integers({ minValue: 0, maxValue: count - 1 })));
      const { records, timeouts } = await judgeWithStop(count, stopAt);
      for (const timeout of timeouts) expect(timeout).toBeGreaterThan(0);
      if (stopAt === null) {
        expect(timeouts).toHaveLength(count);
        expect(records.map((record) => record.outcome)).toEqual(["held", "held"]);
        return;
      }
      expect(timeouts).toHaveLength(stopAt + 1);
      expect(records[0]).toMatchObject({
        outcome: "unjudged",
        reason: `${LIMIT} passed, so nukadoko stopped judging: ${count - stopAt} of ${count} items were not judged`,
      });
      expect(records[1]).toMatchObject({ outcome: "unjudged", reason: `${LIMIT} passed, so nukadoko stopped judging: 1 of 2 claims were not judged` });
    }));

  it("records the item whose pattern was stopped, with the time it was given", async () => {
    const { records } = await judgeWithStop(3, 1);
    const each = records[0] as unknown as { each: { results: { index: number; claims?: { outcome: string; reason?: string }[] }[] } };
    expect(each.each.results.map((result) => [result.index, result.claims?.[0]?.outcome])).toEqual([
      [0, "held"],
      [1, "unjudged"],
    ]);
    expect(each.each.results[1]!.claims![0]!.reason).toBe(`matches did not finish within 99ms (the time left of ${LIMIT}), so nukadoko stopped the pattern`);
  });

  it("leaves every claim unjudged, with one count, when the budget is spent before judging starts", async () => {
    const budget = judgingBudget(0, LIMIT, () => 1);
    const judged = await evaluateClaims(claims, { ...inputs({ re: "x", n: 0 }, { lines: ["x"], count: 0 }), budget });
    expect(judged.map((entry) => entry.record)).toEqual([
      expect.objectContaining({ outcome: "unjudged", reason: `${LIMIT} passed, so nukadoko stopped judging: 2 of 2 claims were not judged` }),
      expect.objectContaining({ outcome: "unjudged", reason: `${LIMIT} passed, so nukadoko stopped judging: 2 of 2 claims were not judged` }),
    ]);
  });

  it("records a claim whose pattern tester threw as it was called, without a promise, as unjudged", async () => {
    const [judged] = await evaluateClaims([{ actual: "out", compare: "matches", expected: "re" }], {
      ...inputs({ re: "a" }, { out: "a" }),
      testPattern: () => {
        throw new Error("Access to this API has been restricted");
      },
    });
    expect(judged!.record).toMatchObject({ outcome: "unjudged", reason: "nukadoko could not judge this claim: Access to this API has been restricted" });
  });
});

describe("the record of a claim", () => {
  const base: Omit<ClaimInputs, "args" | "observed"> = {
    schemaChanged: () => null,
    observeReceived: [],
    fromKeys: new Set(["result"]),
    argSide: (key: string) =>
      key === "result"
        ? { origin: "record:4", segments: ["result"], label: "from:run-tally@4.result" }
        : { origin: `sentence:${key}`, segments: [], label: `sentence:${key}` },
    sentenceText: (key: string) => (key === "result" ? null : `text of ${key}`),
    patterns: ["the tally exits with {code:int}"],
    testPattern: testInProcess,
    budget: judgingBudget(Number.POSITIVE_INFINITY, "a test's budget"),
  };

  it("names the actual value, its source, the compare, the expected value, its source, its text, and the outcome, in that order", async () => {
    const [judged] = await evaluateClaims([{ actual: "result.exitCode", compare: "equal", expected: "code" }], {
      ...base,
      args: readerNow({ code: 0, result: { exitCode: 0, stdout: "" } }),
      observed: readerNow(undefined),
    });
    expect(judged).toEqual({
      record: {
        actual: 0,
        actual_from: "from:run-tally@4.result.exitCode",
        compare: "equal",
        expected: 0,
        expected_from: "sentence:code",
        expected_text: "text of code",
        outcome: "held",
      },
      rawActual: 0,
      fromKey: "result",
      expectedOrigins: [null],
    });
    expect(Object.keys(judged!.record)).toEqual(["actual", "actual_from", "compare", "expected", "expected_from", "expected_text", "outcome"]);
  });

  it("puts view and at after the actual source, names them in the label, and gives no reason for a plain mismatch", async () => {
    const [judged] = await evaluateClaims(
      [{ actual: "page", view: "lines", at: "1", compare: "contains-text", expected: { observe: "title" } }],
      { ...base, args: readerNow({}), observed: readerNow({ page: "Header\nWelcome back\n", title: "Hello" }) },
    );
    expect(judged!.record).toEqual({
      actual: "Welcome back",
      actual_from: "observe:page as lines at 1",
      view: "lines",
      at: "1",
      compare: "contains-text",
      expected: "Hello",
      expected_from: "observe:title",
      expected_text: null,
      outcome: "broken",
    });
    expect(Object.keys(judged!.record)).toEqual(["actual", "actual_from", "view", "at", "compare", "expected", "expected_from", "expected_text", "outcome"]);
    expect(judged!.rawActual).toBe("Header\nWelcome back\n");
    expect(judged!.fromKey).toBeNull();
  });

  it("reads a sentence value through expected_view, and records the view and the text the line stated", async () => {
    const [judged] = await evaluateClaims([{ actual: "result.body", compare: "equal", expected: "body", expected_view: "json" }], {
      ...base,
      sentenceText: () => '{ "id": 7 }',
      args: readerNow({ body: '{ "id": 7 }', result: { body: { id: 7 } } }),
      observed: readerNow(undefined),
    });
    expect(judged!.record).toEqual({
      actual: { id: 7 },
      actual_from: "from:run-tally@4.result.body",
      compare: "equal",
      expected: { id: 7 },
      expected_from: "sentence:body as json",
      expected_view: "json",
      expected_text: '{ "id": 7 }',
      outcome: "held",
    });
  });

  it("names a literal by the pattern words that state it, and records those words as its text", async () => {
    const [judged] = await evaluateClaims([{ actual: "result.stderr", compare: "equal", expected: { literal: "" } }], {
      ...base,
      patterns: ["the tally exits with no error"],
      args: readerNow({ result: { stderr: "" } }),
      observed: readerNow(undefined),
    });
    expect(judged!.record).toMatchObject({ expected: "", expected_from: "literal:no", expected_text: "no", outcome: "held" });
  });

  it("names a from value by the step and line that returned it", async () => {
    const [judged] = await evaluateClaims([{ actual: "rows", compare: "has-item", expected: { from: "result.id" } }], {
      ...base,
      args: readerNow({ result: { id: 7 } }),
      observed: readerNow({ rows: [3, 7] }),
    });
    expect(judged!.record).toMatchObject({ expected: 7, expected_from: "from:run-tally@4.result.id", expected_text: null, outcome: "held" });
  });

  it("breaks a comparison of two different types with both types named", async () => {
    const [judged] = await evaluateClaims([{ actual: "result.exitCode", compare: "equal", expected: "code" }], {
      ...base,
      args: readerNow({ code: "0", result: { exitCode: 0 } }),
      observed: readerNow(undefined),
    });
    expect(judged!.record).toMatchObject({ outcome: "broken", reason: "equal compares a number with a string" });
  });

  it("breaks a claim whose actual is undefined, naming its source, and records no actual", async () => {
    const [judged] = await evaluateClaims([{ actual: "result.missing", compare: "equal", expected: "code" }], {
      ...base,
      args: readerNow({ code: 0, result: {} }),
      observed: readerNow(undefined),
    });
    expect(judged!.record).toEqual({
      actual_from: "from:run-tally@4.result.missing",
      compare: "equal",
      expected: 0,
      expected_from: "sentence:code",
      expected_text: "text of code",
      outcome: "broken",
      reason: "from:run-tally@4.result.missing is undefined",
    });
  });

  it("reads own properties only, so a path through the prototype finds nothing", async () => {
    const [judged] = await evaluateClaims([{ actual: "result.constructor.name", compare: "equal", expected: "code" }], {
      ...base,
      args: readerNow({ code: "Object", result: {} }),
      observed: readerNow(undefined),
    });
    expect(judged!.record).toMatchObject({ outcome: "broken", reason: "from:run-tally@4.result.constructor.name is undefined" });
  });

  it("breaks an expected value observe computed as a boolean, whatever it is", async () => {
    for (const flag of [true, false]) {
      const [judged] = await evaluateClaims([{ actual: "count", compare: "equal", expected: { observe: "done" } }], {
        ...base,
        args: readerNow({}),
        observed: readerNow({ count: flag, done: flag }),
      });
      expect(judged!.record).toMatchObject({
        outcome: "broken",
        reason:
          "the expected value observe:done is a boolean observe computed, which is a judgment made in code: return the thing measured and let the claim compare it",
      });
    }
  });

  it("records a claim nukadoko could not judge as unjudged, with the failure, and judges the next claim", async () => {
    const [failed, next] = await evaluateClaims(
      [
        { actual: "result.stdout", compare: "matches", expected: "code" },
        { actual: "result.exitCode", compare: "equal", expected: { literal: 0 } },
      ],
      {
        ...base,
        patterns: ["the tally exits with 0 and prints {code}"],
        args: readerNow({ code: "x", result: { stdout: "x", exitCode: 0 } }),
        observed: readerNow(undefined),
        testPattern: async () => {
          throw new Error("the worker stopped");
        },
      },
    );
    expect(failed!.record).toEqual({
      actual_from: "from:run-tally@4.result.stdout",
      compare: "matches",
      expected_from: "sentence:code",
      expected_text: "text of code",
      outcome: "unjudged",
      reason: "nukadoko could not judge this claim: the worker stopped",
    });
    expect(next!.record).toMatchObject({ outcome: "held" });
  });

  it("records each item with whether where selected it, and the where and item claims of each", async () => {
    const [judged] = await evaluateClaims(
      [
        {
          actual: "rows",
          each: {
            where: [{ actual: "kind", compare: "equal", expected: "kind" }],
            claims: [{ actual: "total", compare: "at-most", expected: "limit" }],
          },
        },
      ],
      {
        ...base,
        args: readerNow({ kind: "food", limit: 10 }),
        observed: readerNow({
          rows: [
            { kind: "food", total: 4 },
            { kind: "rent", total: 100 },
            { kind: "food", total: 12 },
          ],
        }),
      },
    );
    const where = (index: number, kind: string, outcome: string) => ({
      actual: kind,
      actual_from: `observe:rows.${index}.kind`,
      compare: "equal",
      expected: "food",
      expected_from: "sentence:kind",
      expected_text: "text of kind",
      outcome,
    });
    const total = (index: number, value: number, outcome: string) => ({
      actual: value,
      actual_from: `observe:rows.${index}.total`,
      compare: "at-most",
      expected: 10,
      expected_from: "sentence:limit",
      expected_text: "text of limit",
      outcome,
    });
    expect(judged!.record).toEqual({
      actual_from: "observe:rows",
      each: {
        where: [{ actual: "kind", compare: "equal", expected: "food", expected_from: "sentence:kind", expected_text: "text of kind" }],
        claims: [{ actual: "total", compare: "at-most", expected: 10, expected_from: "sentence:limit", expected_text: "text of limit" }],
        items: 3,
        selected: 2,
        results: [
          { index: 0, selected: true, where: [where(0, "food", "held")], outcome: "held", claims: [total(0, 4, "held")] },
          { index: 1, selected: false, where: [where(1, "rent", "broken")] },
          { index: 2, selected: true, where: [where(2, "food", "held")], outcome: "broken", claims: [total(2, 12, "broken")] },
        ],
      },
      outcome: "broken",
    });
  });

  it("keeps at most 20 item results, broken ones first, and counts the rest", async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({ total: index }));
    const [judged] = await evaluateClaims([{ actual: "rows", each: { claims: [{ actual: "total", compare: "less-than", expected: "limit" }] } }], {
      ...base,
      args: readerNow({ limit: 3 }),
      observed: readerNow({ rows }),
    });
    const each = (judged!.record as unknown as { each: { results: { index: number; outcome: string }[]; results_truncated?: number } }).each;
    expect(each.results).toHaveLength(20);
    expect(each.results_truncated).toBe(25);
    expect(each.results.filter((entry) => entry.outcome === "broken")).toHaveLength(20);
  });
});

describe("a broken equal names where its two values first differ", () => {
  it("names nothing for two values that are the same", () =>
    hegel.test((tc) => {
      const value = tc.draw(jsonValues);
      expect(equalDifference(value, structuredClone(value))).toBeNull();
    }));

  it("names the path of the one value changed inside an object", () =>
    hegel.test((tc) => {
      const { root, path } = tc.draw(rootWithPath);
      const changed = structuredClone(root);
      const segments = path.split(".");
      let parent: any = changed;
      for (const segment of segments.slice(0, -1)) parent = parent[segment];
      parent[segments.at(-1)!] = "\u00a7 changed";
      expect(equalDifference(changed, root)).toMatch(new RegExp(`^first difference at ${path.replaceAll(".", "\\.")}[:,]`));
    }));

  it("names the character where a long text first differs, and shows both sides around it", () =>
    hegel.test((tc) => {
      const text = tc.draw(gs.text({ alphabet: "ab", minSize: 130, maxSize: 200 }));
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: text.length - 1 }));
      const changed = `${text.slice(0, at)}c${text.slice(at + 1)}`;
      const difference = equalDifference(changed, text)!;
      expect(difference).toMatch(new RegExp(`^first difference at character ${at + 1}: actual "[.]*[ab]*c`));
    }));

  it("counts characters in code points, and never cuts one in two", () =>
    hegel.test((tc) => {
      const alphabet = ["a", "\u{1F600}", "\u00e9", "\u{20000}"];
      const points = tc.draw(gs.arrays(gs.sampledFrom(alphabet), { minSize: 130, maxSize: 160 }));
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: points.length - 1 }));
      const changed = points.map((point, index) => (index === at ? (point === "b" ? "c" : "b") : point));
      const difference = equalDifference(changed.join(""), points.join(""))!;
      expect(difference.startsWith(`first difference at character ${at + 1}: `)).toBe(true);
      expect(difference).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }));

  it("names the line where two texts first differ, and leaves a short one-line text to the values the line shows", () => {
    expect(equalDifference("food: 5.5\nrent: 100", "food: 5.5\nrent: 101")).toBe('first difference at line 2: actual "rent: 100", expected "rent: 101"');
    expect(equalDifference({ rows: [{ note: "x\ny" }] }, { rows: [{ note: "x\nz" }] })).toBe('first difference at rows.0.note, line 2: actual "y", expected "z"');
    expect(equalDifference([1, 2], [1, 2, 3])).toBe("first difference at 2: actual nothing, expected 3");
    expect(equalDifference("short", "shirt")).toBeNull();
    expect(equalDifference(1, 2)).toBeNull();
  });
});

describe("a broken fits-text names how far the expected text fit, and where it stopped", () => {
  it("names nothing for a text that fits", () =>
    hegel.test((tc) => {
      const text = tc.draw(gs.text({ alphabet: "ab\n", maxSize: 8 }));
      expect(fitsDifference(text, text)).toBeNull();
    }));

  it("names the expected lines that fit, the first that fits nothing, and the actual line where it stopped", () => {
    const out = "built 3 files in 41ms\nwrote dist/a.js\nwrote dist/b.js\ndone\n";
    expect(fitsDifference(out, "built [..] files in [..]ms\n...\nwrote dist/c.js\ndone")).toBe(
      'expected lines 1 to 2 fit, and expected line 3 fits nothing from actual line 2: actual "wrote dist/a.js", expected "wrote dist/c.js"',
    );
    expect(fitsDifference(out, "built 2 files in [..]ms\n...")).toBe('expected line 1 fits nothing from actual line 1: actual "built 3 files in 41ms", expected "built 2 files in [..]ms"');
    expect(fitsDifference(out, "built [..]\nwrote dist/a.js\nwrote dist/b.js\ndone\nexit 0")).toBe('expected lines 1 to 4 fit, and expected line 5 fits nothing from actual line 5: actual nothing, expected "exit 0"');
    expect(fitsDifference(out, "built [..]\nwrote dist/a.js")).toBe('every expected line fits, and actual line 3 is left over: actual "wrote dist/b.js"');
  });
});

describe("a broken has-fields names the first expected field that does not fit", () => {
  it("names nothing for an expected object that fits", () =>
    hegel.test((tc) => {
      const value = tc.draw(jsonValues);
      expect(fieldsDifference(value, structuredClone(value))).toBeNull();
    }));

  it("names a missing field, a value that differs, and an array of another length, each with its path and both sides", () => {
    const body = { id: 7, owner: { name: "aki", note: "a\nb" }, tags: ["x", "y"] };
    expect(fieldsDifference(body, { owner: { email: "a@example.com" } })).toBe('first field that does not fit at owner.email: actual nothing, expected "a@example.com"');
    expect(fieldsDifference(body, { id: 7, owner: { name: "kei" } })).toBe('first field that does not fit at owner.name: actual "aki", expected "kei"');
    expect(fieldsDifference(body, { owner: { note: "a\nc" } })).toBe('first field that does not fit at owner.note, line 2: actual "b", expected "c"');
    expect(fieldsDifference(body, { tags: ["x"] })).toBe("first field that does not fit at tags: actual 2 items, expected 1 item");
    expect(fieldsDifference(body, { tags: ["x", "z"] })).toBe('first field that does not fit at tags.1: actual "y", expected "z"');
  });
});

describe("an expected value a compare can never judge as the sentence means it", () => {
  it("refuses has-fields with any literal, and with a sentence key read as anything but JSON", () =>
    hegel.test((tc) => {
      const literal = tc.draw(patternWords).join(" ");
      expect(claimsProblem([{ actual: "result", compare: "has-fields", expected: { literal } }], literalShape(`the result is ${literal}`))).toContain(
        "which is never an object, and has-fields compares two objects, so the claim always breaks",
      );
      const view = tc.draw(gs.sampledFrom([undefined, "text", "lines", "comma-list"] as const));
      const claim = { actual: "result", compare: "has-fields", expected: "fields", ...(view === undefined ? {} : { expected_view: view }) };
      expect(claimsProblem([claim], literalShape("the result reads"))).toContain("never an object, so has-fields always breaks");
      expect(claimsProblem([{ ...claim, expected_view: "json" }], literalShape("the result reads"))).toBeNull();
    }));

  it("refuses is-a with a literal that names no kind, or a kind its view always makes, and takes any other kind", () =>
    hegel.test((tc) => {
      const kind = tc.draw(gs.sampledFrom(VALUE_KINDS));
      const view = tc.draw(gs.sampledFrom([undefined, "text", "lines", "json", "comma-list"] as const));
      const at = tc.draw(gs.booleans()) ? "0" : undefined;
      const claim = { actual: "result", ...(view === undefined ? {} : { view }), ...(at === undefined ? {} : { at }), compare: "is-a", expected: { literal: kind } };
      const problem = claimsProblem([claim], literalShape(`the result is a ${kind}`));
      const strings = view === "text" && (kind === "string" || kind === "text");
      const arrays = (view === "lines" || view === "comma-list") && (kind === "list" || kind === "array");
      if (at === undefined && (strings || arrays)) expect(problem).toContain("holds whenever the view applies and states nothing");
      else expect(problem).toBeNull();
      const word = tc.draw(gs.text({ alphabet: "xyz", minSize: 1, maxSize: 5 }));
      expect(claimsProblem([{ actual: "result", compare: "is-a", expected: { literal: word } }], literalShape(`the result is a ${word}`))).toContain(
        `and is-a names one of the kinds ${VALUE_KINDS.join(", ")}, so the claim always breaks`,
      );
    }));

  it("refuses fits-text whose expected text a step returned or observe read, and takes one the sentence states", () => {
    const observed = { ...literalShape("the build prints done"), hasObserve: true };
    const stands = 'fits-text reads each "..." line and each "[..]" of its expected text as a stand-in';
    expect(claimsProblem([{ actual: "result", compare: "fits-text", expected: { observe: "printed" } }], observed)).toContain(stands);
    expect(claimsProblem([{ actual: "printed", compare: "fits-text", expected: { from: "result.out" } }], observed)).toContain(stands);
    expect(claimsProblem([{ actual: "result", compare: "fits-text", expected: "out" }], literalShape("the build prints"))).toBeNull();
    expect(claimsProblem([{ actual: "result", compare: "fits-text", expected: { literal: "done" } }], literalShape("the build prints done"))).toBeNull();
  });
});
