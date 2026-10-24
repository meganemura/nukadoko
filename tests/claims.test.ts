import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Generator } from "@hegeldev/hegel/generators";
import type { ClaimCompare } from "../src/record/types.js";
import { claimsProblem, literalStatedBy, type Claim, type ClaimStepShape } from "../src/step/claims.js";
import {
  applyView,
  compareValues,
  deepEqual,
  evaluateClaims,
  jsonType,
  pollReadings,
  POLL_INTERVAL_MS,
  valueAt,
  type ClaimInputs,
  type Reading,
} from "../src/step/evaluate-claims.js";

// Responsibility: the judging rules of a claim (docs/spec.md "Claims") as
// properties over drawn values: each compare against its negation, a
// comparison across two JSON types, `view` and `at` on drawn JSON, the
// literal rule, `each` over nothing, and the two consecutive readings
// `poll` rests a pass on. These are pure functions, so a property says
// what an example cannot: that no drawn value makes a rule bend.

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

function inputs(args: Record<string, unknown>, observation: unknown, fromKeys: readonly string[] = []): ClaimInputs {
  return {
    args,
    observation,
    fromKeys: new Set(fromKeys),
    argLabel: (key) => (fromKeys.includes(key) ? `from:produce@3.${key}` : `sentence:${key}`),
    patterns: ["the value is {want}"],
  };
}

function judgeOne(claim: Claim, args: Record<string, unknown>, observation: unknown, fromKeys: readonly string[] = []) {
  const [judged] = evaluateClaims([claim], inputs(args, observation, fromKeys));
  return judged!.record;
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
  "has-item",
  "matches",
  "greater-than",
  "at-least",
  "less-than",
  "at-most",
];

function holds(result: { holds: boolean } | { reason: string }): boolean {
  if ("reason" in result) throw new Error(`expected a comparison, got the reason: ${result.reason}`);
  return result.holds;
}

describe("compares", () => {
  it("equal and not-equal disagree on every pair of values of one JSON type", () =>
    hegel.test((tc) => {
      const a = tc.draw(jsonValues);
      const b = tc.draw(gs.booleans()) ? structuredClone(a) : tc.draw(jsonValues);
      tc.assume(jsonType(a) === jsonType(b));
      expect(holds(compareValues("equal", a, b))).toBe(!holds(compareValues("not-equal", a, b)));
      expect(holds(compareValues("equal", a, b))).toBe(deepEqual(a, b));
    }));

  it("each order compare disagrees with its negation on every pair of numbers", () =>
    hegel.test((tc) => {
      const [compare, negation] = tc.draw(gs.sampledFrom(NEGATION_PAIRS.slice(1)));
      const a = tc.draw(gs.floats({ allowNan: false, allowInfinity: false }));
      const b = tc.draw(gs.booleans()) ? a : tc.draw(gs.floats({ allowNan: false, allowInfinity: false }));
      expect(holds(compareValues(compare, a, b))).toBe(!holds(compareValues(negation, a, b)));
    }));

  it("each order compare disagrees with its negation on every pair of bigints", () =>
    hegel.test((tc) => {
      const [compare, negation] = tc.draw(gs.sampledFrom(NEGATION_PAIRS.slice(1)));
      const a = tc.draw(gs.bigIntegers({ minValue: -1000n, maxValue: 1000n }));
      const b = tc.draw(gs.bigIntegers({ minValue: -1000n, maxValue: 1000n }));
      expect(holds(compareValues(compare, a, b))).toBe(!holds(compareValues(negation, a, b)));
    }));

  it("contains-text holds when the text holds the expected value, and breaks when it holds a letter the text has none of", () =>
    hegel.test((tc) => {
      const before = tc.draw(gs.text({ alphabet: "ab", maxSize: 4 }));
      const after = tc.draw(gs.text({ alphabet: "ab", maxSize: 4 }));
      const needle = tc.draw(gs.text({ alphabet: "ab", minSize: 1, maxSize: 3 }));
      expect(holds(compareValues("contains-text", `${before}${needle}${after}`, needle))).toBe(true);
      expect(holds(compareValues("contains-text", `${before}${after}`, `${needle}c`))).toBe(false);
    }));

  it("matches holds when the text holds the pattern, and breaks when the pattern needs a letter the text has none of", () =>
    hegel.test((tc) => {
      const text = tc.draw(gs.text({ alphabet: "ab", maxSize: 6 }));
      const piece = tc.draw(gs.text({ alphabet: "ab", minSize: 1, maxSize: 3 }));
      expect(holds(compareValues("matches", `${text}${piece}`, `${piece}$`))).toBe(true);
      expect(holds(compareValues("matches", text, `${piece}c`))).toBe(false);
    }));

  it("has-item holds when one item equals the expected value, and breaks when none does", () =>
    hegel.test((tc) => {
      const items = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 9 }), { maxSize: 5 }));
      const wanted = tc.draw(gs.integers({ minValue: 0, maxValue: 9 }));
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: items.length }));
      const withIt = [...items.slice(0, at), wanted, ...items.slice(at)];
      const without = items.filter((item) => item !== wanted);
      expect(holds(compareValues("has-item", withIt, wanted))).toBe(true);
      expect(holds(compareValues("has-item", without, wanted))).toBe(false);
    }));

  it("never holds across two JSON types, and names both types", () =>
    hegel.test((tc) => {
      const actual = tc.draw(jsonValues);
      const expected = tc.draw(jsonValues);
      tc.assume(jsonType(actual) !== jsonType(expected));
      const compare = tc.draw(gs.sampledFrom(ALL_COMPARES.filter((entry) => entry !== "has-item")));
      const result = compareValues(compare, actual, expected);
      expect(result).toHaveProperty("reason");
      const reason = (result as { reason: string }).reason;
      expect(reason).toContain(jsonType(actual));
      expect(reason).toContain(jsonType(expected));
    }));

  it("has-item never holds on an array whose items are all of another type than the expected value", () =>
    hegel.test((tc) => {
      const items = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 9 }), { minSize: 1, maxSize: 4 }));
      const expected = tc.draw(gs.oneOf<unknown>(gs.text({ alphabet: "0123456789", maxSize: 2 }), gs.booleans(), gs.just(null)));
      expect(compareValues("has-item", items, expected)).toHaveProperty("reason");
      const notArray = tc.draw(gs.oneOf<unknown>(gs.text({ alphabet: "ab", maxSize: 3 }), gs.integers(), gs.just(null)));
      expect(compareValues("has-item", notArray, expected)).toHaveProperty("reason");
    }));

  it("a claim across two JSON types is broken, whichever compare it names", () =>
    hegel.test((tc) => {
      const actual = tc.draw(jsonValues);
      const want = tc.draw(jsonValues);
      tc.assume(jsonType(actual) !== jsonType(want));
      const compare = tc.draw(gs.sampledFrom(ALL_COMPARES.filter((entry) => entry !== "has-item")));
      const record = judgeOne({ actual: "value", compare, expected: "want" }, { want }, { value: actual });
      expect(record.outcome).toBe("broken");
    }));
});

describe("view and at", () => {
  it("view json with at reads the value at that path of the JSON text", () =>
    hegel.test((tc) => {
      const { root, path, value } = tc.draw(rootWithPath);
      const viewed = applyView("json", JSON.stringify(root));
      expect("value" in viewed && deepEqual(valueAt(viewed.value, path), value)).toBe(true);
      const record = judgeOne(
        { actual: "stdout", view: "json", at: path, compare: "equal", expected: "want" },
        { want: structuredClone(value) },
        { stdout: `${JSON.stringify(root)}\n` },
      );
      expect(record.outcome).toBe("held");
      expect(deepEqual((record as { actual?: unknown }).actual, value)).toBe(true);
    }));

  it("at a path the value does not hold breaks, and says where", () =>
    hegel.test((tc) => {
      const { root, path } = tc.draw(rootWithPath);
      const at = `${path}.zz`;
      const record = judgeOne(
        { actual: "stdout", view: "json", at, compare: "equal", expected: "want" },
        { want: 0 },
        { stdout: JSON.stringify(root) },
      );
      expect(record.outcome).toBe("broken");
      expect(record.reason).toBe(`stdout as json has nothing at ${at}`);
      expect(record).not.toHaveProperty("actual");
    }));

  it("valueAt on a path of a drawn object returns what walking the path reaches", () =>
    hegel.test((tc) => {
      const { root, path, value } = tc.draw(rootWithPath);
      expect(deepEqual(valueAt(root, path), value)).toBe(true);
    }));

  it("view lines at an index reads that line, whatever the line ending", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(gs.text({ alphabet: "ab", minSize: 1, maxSize: 4 }), { minSize: 1, maxSize: 5 }));
      const ending = tc.draw(gs.sampledFrom(["\n", "\r\n"]));
      const trailing = tc.draw(gs.sampledFrom(["", ending, `${ending}${ending}`]));
      const text = `${lines.join(ending)}${trailing}`;
      const index = tc.draw(gs.integers({ minValue: 0, maxValue: lines.length - 1 }));
      expect(applyView("lines", text)).toEqual({ value: lines });
      const record = judgeOne(
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
      expect(applyView(view, value)).toEqual({ reason: `view ${view} reads a string, and the value is a ${jsonType(value)}` });
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

describe("each", () => {
  const itemClaims = [{ actual: "n", compare: "at-least", expected: "least" }] as const;

  it("an empty array is always broken, whatever the item claims say", () =>
    hegel.test((tc) => {
      const least = tc.draw(gs.integers({ minValue: -10, maxValue: 10 }));
      const where = tc.draw(gs.booleans()) ? { where: [{ actual: "n", compare: "less-than", expected: "least" }] as const } : {};
      const record = judgeOne({ actual: "rows", each: { ...where, claims: itemClaims } }, { least, rows: [] }, undefined, ["rows"]);
      expect(record).toEqual({
        actual_from: "from:produce@3.rows",
        each: { items: 0, selected: 0, results: [] },
        outcome: "broken",
        reason: "the array is empty, and a claim on every item of nothing measures nothing",
      });
    }));

  it("a where that selects no item is always broken", () =>
    hegel.test((tc) => {
      const rows = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 9 }).map((n) => ({ n })), { minSize: 1, maxSize: 6 }));
      const limit = tc.draw(gs.integers({ minValue: 9, maxValue: 100 }));
      const record = judgeOne(
        { actual: "rows", each: { where: [{ actual: "n", compare: "greater-than", expected: "limit" }], claims: itemClaims } },
        { least: 0, limit, rows },
        undefined,
        ["rows"],
      );
      expect(record.outcome).toBe("broken");
      expect(record).toMatchObject({ each: { items: rows.length, selected: 0, results: [] } });
      expect(record.reason).toBe(
        `where selected none of the ${rows.length} items, and a claim on none of them measures nothing`,
      );
    }));

  it("holds exactly when every selected item holds", () =>
    hegel.test((tc) => {
      const rows = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 9 }).map((n) => ({ n })), { minSize: 1, maxSize: 6 }));
      const least = tc.draw(gs.integers({ minValue: 0, maxValue: 9 }));
      const record = judgeOne({ actual: "rows", each: { claims: itemClaims } }, { least, rows }, undefined, ["rows"]);
      expect(record.outcome).toBe(rows.every((row) => row.n >= least) ? "held" : "broken");
    }));
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
      const result = await pollReadings(read, (value) => value === true, timeout, fakeClock());
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
      const result = await pollReadings(read, (value) => value === true, timeout, fakeClock());
      expect(result.attempts).toBeLessThanOrEqual(Math.ceil(timeout / POLL_INTERVAL_MS) + 2);
    }));

  it("reads exactly twice when every reading holds", () =>
    hegel.testAsync(async (tc) => {
      const timeout = tc.draw(timeouts);
      const result = await pollReadings(async () => ({ ok: true, value: 1 }), (value) => value === 1, timeout, fakeClock());
      expect(result.attempts).toBe(2);
    }));
});

describe("the record of a claim", () => {
  const base = {
    fromKeys: new Set(["result"]),
    argLabel: (key: string) => (key === "result" ? "from:run-tally@4.result" : `sentence:${key}`),
    patterns: ["the tally exits with {code:int}"],
  };

  it("names the actual value, its source, the compare, the expected value, its source, and the outcome, in that order", () => {
    const [judged] = evaluateClaims([{ actual: "result.exitCode", compare: "equal", expected: "code" }], {
      ...base,
      args: { code: 0, result: { exitCode: 0, stdout: "" } },
      observation: undefined,
    });
    expect(judged).toEqual({
      record: {
        actual: 0,
        actual_from: "from:run-tally@4.result.exitCode",
        compare: "equal",
        expected: 0,
        expected_from: "sentence:code",
        outcome: "held",
      },
      rawActual: 0,
      fromKey: "result",
    });
    expect(Object.keys(judged!.record)).toEqual(["actual", "actual_from", "compare", "expected", "expected_from", "outcome"]);
  });

  it("puts view and at after the actual source, and gives no reason for a plain mismatch", () => {
    const [judged] = evaluateClaims(
      [{ actual: "page", view: "lines", at: "1", compare: "contains-text", expected: { observe: "title" } }],
      { ...base, args: {}, observation: { page: "Header\nWelcome back\n", title: "Hello" } },
    );
    expect(judged!.record).toEqual({
      actual: "Welcome back",
      actual_from: "observe:page",
      view: "lines",
      at: "1",
      compare: "contains-text",
      expected: "Hello",
      expected_from: "observe:title",
      outcome: "broken",
    });
    expect(Object.keys(judged!.record)).toEqual(["actual", "actual_from", "view", "at", "compare", "expected", "expected_from", "outcome"]);
    expect(judged!.rawActual).toBe("Header\nWelcome back\n");
    expect(judged!.fromKey).toBeNull();
  });

  it("names a literal by the pattern words that state it", () => {
    const [judged] = evaluateClaims([{ actual: "result.stderr", compare: "equal", expected: { literal: "" } }], {
      ...base,
      patterns: ["the tally exits with no error"],
      args: { result: { stderr: "" } },
      observation: undefined,
    });
    expect(judged!.record).toMatchObject({ expected: "", expected_from: "literal:no", outcome: "held" });
  });

  it("names a from value by the step and line that returned it", () => {
    const [judged] = evaluateClaims([{ actual: "rows", compare: "has-item", expected: { from: "result.id" } }], {
      ...base,
      fromKeys: new Set(["result"]),
      args: { result: { id: 7 } },
      observation: { rows: [3, 7] },
    });
    expect(judged!.record).toMatchObject({ expected: 7, expected_from: "from:run-tally@4.result.id", outcome: "held" });
  });

  it("breaks a comparison of two different types with both types named", () => {
    const [judged] = evaluateClaims([{ actual: "result.exitCode", compare: "equal", expected: "code" }], {
      ...base,
      args: { code: "0", result: { exitCode: 0 } },
      observation: undefined,
    });
    expect(judged!.record).toMatchObject({ outcome: "broken", reason: "equal compares a number with a string" });
  });

  it("breaks a claim whose actual is undefined, naming its path, and records no actual", () => {
    const [judged] = evaluateClaims([{ actual: "result.missing", compare: "equal", expected: "code" }], {
      ...base,
      args: { code: 0, result: {} },
      observation: undefined,
    });
    expect(judged!.record).toEqual({
      actual_from: "from:run-tally@4.result.missing",
      compare: "equal",
      expected: 0,
      expected_from: "sentence:code",
      outcome: "broken",
      reason: "result.missing is undefined",
    });
  });

  it("records each item that a where selected, with its index and its own claims", () => {
    const [judged] = evaluateClaims(
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
        args: { kind: "food", limit: 10 },
        observation: {
          rows: [
            { kind: "food", total: 4 },
            { kind: "rent", total: 100 },
            { kind: "food", total: 12 },
          ],
        },
      },
    );
    expect(judged!.record).toEqual({
      actual_from: "observe:rows",
      each: {
        items: 3,
        selected: 2,
        results: [
          {
            index: 0,
            outcome: "held",
            claims: [
              {
                actual: 4,
                actual_from: "observe:rows[0].total",
                compare: "at-most",
                expected: 10,
                expected_from: "sentence:limit",
                outcome: "held",
              },
            ],
          },
          {
            index: 2,
            outcome: "broken",
            claims: [
              {
                actual: 12,
                actual_from: "observe:rows[2].total",
                compare: "at-most",
                expected: 10,
                expected_from: "sentence:limit",
                outcome: "broken",
              },
            ],
          },
        ],
      },
      outcome: "broken",
    });
  });

  it("keeps at most 20 item results, broken ones first, and counts the rest", () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({ total: index }));
    const [judged] = evaluateClaims([{ actual: "rows", each: { claims: [{ actual: "total", compare: "less-than", expected: "limit" }] } }], {
      ...base,
      args: { limit: 3 },
      observation: { rows },
    });
    const each = (judged!.record as unknown as { each: { results: { index: number; outcome: string }[]; results_truncated?: number } }).each;
    expect(each.results).toHaveLength(20);
    expect(each.results_truncated).toBe(25);
    expect(each.results.filter((entry) => entry.outcome === "broken")).toHaveLength(20);
  });
});
