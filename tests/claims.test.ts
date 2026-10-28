import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Generator } from "@hegeldev/hegel/generators";
import type { ClaimCompare } from "../src/record/types.js";
import {
  ANY_INDEX,
  claimArgKeysRead,
  claimsProblem,
  LITERAL_WORDS,
  literalStatedBy,
  NUMBER_WORDS,
  itemPathsOverlap,
  placeAt,
  placesOverlap,
  placeViewed,
  samePlace,
  type Claim,
  type ClaimPlace,
  type ClaimStepShape,
} from "../src/step/claims.js";
import {
  applyView,
  compareValues,
  deepEqual,
  evaluateClaims,
  jsonType,
  judgingBudget,
  pollReadings,
  POLL_INTERVAL_MS,
  readerNow,
  whereImplies,
  type ClaimInputs,
  type PatternTester,
  type Reading,
} from "../src/step/evaluate-claims.js";
import { readAt, snapshot } from "../src/step/snapshot.js";

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

  it("never holds across two JSON types, and names both types", () =>
    hegel.testAsync(async (tc) => {
      const actual = tc.draw(jsonValues);
      const expected = tc.draw(jsonValues);
      tc.assume(jsonType(actual) !== jsonType(expected));
      const name = tc.draw(gs.sampledFrom(ALL_COMPARES.filter((entry) => entry !== "has-item")));
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
      const name = tc.draw(gs.sampledFrom(ALL_COMPARES.filter((entry) => entry !== "has-item")));
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
        `claims[0].expected is the literal ${JSON.stringify(literal)}, which the ${negated ? `words "not ${word}" rule out` : `word "${word}" fixes`}, and claims[0].compare is "${compare}". A value a word fixes is compared with equal alone, or with not-equal alone right after the word \"not\" (\"is not empty\"): another compare against it holds for nearly anything, and the word does not show it`,
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
    const view = tc.draw(gs.sampledFrom([undefined, "text", "json"] as const));
    return { ...(actual === "" ? {} : { actual }), ...(at === "" ? {} : { at }), ...(view === undefined ? {} : { view }), compare, expected };
  }

  const decides = ["equal", "contains-text", "starts-with-text", "ends-with-text", "matches", "has-item"] as const;
  const leaves = ["greater-than", "at-least", "less-than", "at-most", "not-equal"] as const;

  it("refuses a where clause whose place overlaps an item claim's when it compares with equal, a text compare, matches, or has-item, however actual, at, and view spell the places", () =>
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
      const claims: Claim[] = inWhere
        ? [{ actual: "result", each: { where: named.map((key) => ({ actual: "n", compare: "at-least" as const, expected: key })), claims: [{ actual: "m", compare: "at-least", expected: named[0]! }] } }]
        : named.map((key) => ({ actual: "result", compare: "equal" as const, expected: key }));
      const shape: ClaimStepShape = { ...literalShape(`the result is ${[...captured].map((key) => `{${key}}`).join(" ")}`), captureKeys: captured, hasObserve };
      const problem = claimsProblem(claims, shape);
      const unread = [...captured].find((key) => !named.includes(key));
      if (hasObserve || unread === undefined) expect(problem).toBeNull();
      else expect(problem).toBe(`the pattern captures "${unread}", and no claim reads it, and the step has no observe to receive it, so nothing checks the value the line states. Compare a claim with "${unread}", or take it out of the pattern`);
      expect(claimArgKeysRead(claims)).toEqual(new Set(["result", ...named]));
    }));
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
