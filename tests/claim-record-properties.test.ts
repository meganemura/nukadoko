import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Generator } from "@hegeldev/hegel/generators";
import { z } from "zod";
import { certainlySamePlace, closedObjectKeys, closedObjectKeysAt, nonArrayNouns } from "../src/check/claim-check.js";
import { type ChainedJsonType, wordLiteral } from "../src/cli/scaffold.js";
import type { ClaimReading, StepRecord } from "../src/record/types.js";
import { judgedBy, scenarioClaims } from "../src/run/run-document.js";
import { ANY_INDEX, claimsProblem, literalStatedBy, numberOfWord, tableValuesOf } from "../src/step/claims.js";
import {
  CLAIM_READING_MAX_BYTES,
  CLAIM_READINGS_CAP,
  createReadingsLog,
  failedReading,
  keptReadings,
  readingOf,
  readingValue,
  type JudgedClaim,
} from "../src/step/evaluate-claims.js";

// Responsibility: the pure parts of what a claim leaves in the record
// (docs/spec.md "Claims" and "Records"), as properties over drawn values:
// which readings of a poll the step record keeps, how one reading keeps a
// value, when `nuka check` calls two places the same, the claim counts and
// the `judged_by` of a scenario entry in run.json, and the literal
// `nuka scaffold --then` writes for a line that states its value with a
// word. Running a step is tests/claim-steps-run.test.ts's job.

const jsonValue = (depth: number): Generator<unknown> => {
  const leaf = gs.oneOf<unknown>(
    gs.just(null),
    gs.booleans(),
    gs.integers({ minValue: -30, maxValue: 30 }),
    gs.text({ alphabet: "aé\"\\\n", maxSize: 4 }),
  );
  if (depth === 0) return leaf;
  const child = jsonValue(depth - 1);
  return gs.oneOf<unknown>(
    leaf,
    gs.arrays(child, { maxSize: 3 }),
    gs.composite((tc) => {
      const obj: Record<string, unknown> = {};
      const count = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
      for (let i = 0; i < count; i++) obj[tc.draw(gs.text({ alphabet: "ab", minSize: 1, maxSize: 2 }))] = tc.draw(child);
      return obj;
    }),
  );
};

/** A comparison judged as broken, read from `actual` and compared with
 * `expected`, its expected value from each origin. */
function judged(actual: unknown, expected: unknown, origins: readonly ("observe" | null)[]): JudgedClaim {
  return {
    record: { actual, actual_from: "observe:count", compare: "equal", expected, expected_from: "observe:want", expected_text: null, outcome: "broken" },
    rawActual: actual,
    fromKey: null,
    expectedOrigins: origins,
  };
}

function reading(attempt: number, value: number): ClaimReading {
  return { attempt, at: `2026-01-01T00:00:00.${String(attempt).padStart(3, "0")}Z`, held: value === 9, actuals: [{ value }] };
}

/** The rule docs/spec.md "Poll" states, written as plainly as possible:
 * every reading up to the cap; past it, the first, the last, and the
 * earliest and latest change points between them. */
function wantedAttempts(values: readonly number[], cap: number): { kept: number[]; changesLeftOut: number } {
  const all = values.map((_, index) => index + 1);
  if (values.length <= cap) return { kept: all, changesLeftOut: 0 };
  const changes = all.slice(1, -1).filter((attempt) => values[attempt - 1] !== values[attempt - 2]);
  const head = Math.floor((cap - 2) / 2);
  const tail = cap - 2 - head;
  const chosen = changes.length <= head + tail ? changes : [...changes.slice(0, head), ...changes.slice(changes.length - tail)];
  return { kept: [1, ...chosen, values.length], changesLeftOut: changes.length - chosen.length };
}

describe("the readings a poll keeps", () => {
  it("keeps every reading up to the cap, and past it the first, the last, and the change points, saying what it left out", () =>
    hegel.test((tc) => {
      const cap = tc.draw(gs.integers({ minValue: 2, maxValue: 8 }));
      const values = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 3 }), { maxSize: 30 }));
      const kept = keptReadings(values.map((value, index) => reading(index + 1, value)), cap);
      const want = wantedAttempts(values, cap);
      expect(kept.readings.map((entry) => entry.attempt)).toEqual(want.kept);
      if (values.length <= cap) expect(kept.left_out).toBeUndefined();
      else expect(kept.left_out).toEqual({ readings: values.length - want.kept.length, change_points: want.changesLeftOut });
    }));

  it("keeps every change of a value that walks toward the expected one, however many readings repeat between", () =>
    hegel.test((tc) => {
      const steps = tc.draw(gs.integers({ minValue: 1, maxValue: Math.floor((CLAIM_READINGS_CAP - 2) / 2) }));
      const padding = tc.draw(gs.integers({ minValue: 0, maxValue: 40 }));
      const values: number[] = [];
      for (let step = 0; step < steps; step++) values.push(step, ...Array<number>(padding).fill(step));
      values.push(9, 9);
      const kept = keptReadings(values.map((value, index) => reading(index + 1, value)));
      const keptValues = kept.readings.map((entry) => (entry.actuals![0] as { value: number }).value);
      for (let step = 0; step < steps; step++) expect(keptValues).toContain(step);
      expect(keptValues.at(-1)).toBe(9);
      expect(kept.left_out?.change_points ?? 0).toBe(0);
    }));

  it("counts a reading whose value differs only past the cut as a change point, as the full values would", () =>
    hegel.test((tc) => {
      // Each value is a long text whose first CLAIM_READING_MAX_BYTES
      // characters are one and the same, so every kept reading looks alike
      // and only the full value tells two apart.
      const cap = tc.draw(gs.integers({ minValue: 2, maxValue: 8 }));
      const tails = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 3 }), { maxSize: 30 }));
      const log = createReadingsLog(cap);
      tails.forEach((tail, index) => {
        const { reading, content } = readingOf(index + 1, "2026-01-01T00:00:00.000Z", [judged("a".repeat(CLAIM_READING_MAX_BYTES + 4) + String(tail), 7, [null])]);
        expect("json_start" in reading.actuals![0]!).toBe(true);
        log.add(reading, content);
      });
      const want = wantedAttempts(tails, cap);
      expect(log.kept().readings.map((entry) => entry.attempt)).toEqual(want.kept);
    }));

  it("keeps each claim's expected value too, exactly when an expected value comes from observe", () =>
    hegel.test((tc) => {
      const origins = tc.draw(gs.arrays(gs.sampledFrom<"observe" | null>(["observe", null]), { minSize: 1, maxSize: 4 }));
      const claims = origins.map((origin, index) => judged(index, index * 10, [origin]));
      const { reading } = readingOf(1, "2026-01-01T00:00:00.000Z", claims);
      expect(reading.actuals).toEqual(origins.map((_, index) => ({ value: index })));
      if (origins.includes("observe")) expect(reading.expecteds).toEqual(origins.map((_, index) => ({ value: index * 10 })));
      else expect(reading.expecteds).toBeUndefined();
    }));

  it("keeps a value whose JSON fits whole, and the start and byte length of one that does not", () =>
    hegel.testAsync(async (tc) => {
      const value = tc.draw(
        gs.oneOf<unknown>(jsonValue(2), gs.text({ alphabet: "aé", minSize: CLAIM_READING_MAX_BYTES - 8, maxSize: CLAIM_READING_MAX_BYTES + 8 })),
      );
      const text = JSON.stringify(value);
      const bytes = Buffer.byteLength(text, "utf8");
      const kept = readingValue(value, undefined);
      if (bytes <= CLAIM_READING_MAX_BYTES) {
        expect(kept).toEqual({ value });
        return;
      }
      if (!("json_start" in kept)) throw new Error(`expected json_start, got ${JSON.stringify(kept)}`);
      expect(text.startsWith(kept.json_start)).toBe(true);
      expect(kept.json_start.length).toBeLessThanOrEqual(CLAIM_READING_MAX_BYTES);
      expect(kept.json_bytes).toBe(bytes);
    }));

  it("keeps the reason, not a value, where there was no value to keep", () => {
    expect(readingValue(undefined, "args.count is not there")).toEqual({ reason: "args.count is not there" });
    expect(readingValue(undefined, undefined)).toEqual({ reason: "no value" });
    expect(readingValue(10n, undefined)).toEqual({ reason: "the value is not JSON" });
  });

  it("keeps the first line of what observe threw", () =>
    hegel.testAsync(async (tc) => {
      const first = tc.draw(gs.text({ alphabet: "ab ", maxSize: 6 }));
      const rest = tc.draw(gs.arrays(gs.text({ alphabet: "ab ", maxSize: 4 }), { maxSize: 3 }));
      const kept = failedReading(3, "t", new Error([first, ...rest].join("\n")));
      expect(kept).toEqual({ attempt: 3, at: "t", held: false, error: first });
    }));
});

const segments: Generator<string[]> = gs.arrays(gs.sampledFrom(["a", "b", "0", "1", ANY_INDEX, "#view:text", "#at:2"]), { maxSize: 4 });
const places = gs.composite((tc) => ({ origin: tc.draw(gs.sampledFrom(["args.count", "args.total", "observe", "from:make@3"])), segments: tc.draw(segments) }));

describe("when nuka check calls two places the same", () => {
  it("is reflexive and symmetric", () =>
    hegel.testAsync(async (tc) => {
      const a = tc.draw(places);
      const b = tc.draw(places);
      expect(certainlySamePlace(a, { origin: a.origin, segments: [...a.segments] })).toBe(true);
      expect(certainlySamePlace(a, b)).toBe(certainlySamePlace(b, a));
    }));

  it("never calls any item the same as one item: the check stays silent where only the run can know", () =>
    hegel.testAsync(async (tc) => {
      const place = tc.draw(places);
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: place.segments.length }));
      const index = tc.draw(gs.sampledFrom(["0", "1", "7"]));
      const any = { origin: place.origin, segments: [...place.segments.slice(0, at), ANY_INDEX, ...place.segments.slice(at)] };
      const one = { origin: place.origin, segments: [...place.segments.slice(0, at), index, ...place.segments.slice(at)] };
      expect(certainlySamePlace(any, one)).toBe(false);
      expect(certainlySamePlace(any, any)).toBe(true);
    }));

  it("calls two places with different origins different, whatever their paths", () =>
    hegel.testAsync(async (tc) => {
      const path = tc.draw(segments);
      expect(certainlySamePlace({ origin: "args.count", segments: path }, { origin: "observe", segments: path })).toBe(false);
    }));
});

describe("an object schema that keeps no key it does not declare", () => {
  const KINDS = ["object", "strictObject", "looseObject", "catchall"] as const;
  const WRAPPERS = ["optional", "nullable", "readonly", "prefault", "default", "catch"] as const;
  /** An object schema of one kind over drawn keys, inside drawn wrappers.
   * A default or a catch holds a value with a key the object does not
   * declare, since either returns its value without parsing it. */
  const objectSchemas = gs.composite((tc) => {
    const keys = [...new Set(tc.draw(gs.arrays(gs.text({ alphabet: "abc", minSize: 1, maxSize: 2 }), { maxSize: 3 })))];
    const kind = tc.draw(gs.sampledFrom(KINDS));
    const shape = Object.fromEntries(keys.map((key) => [key, z.number().optional()]));
    let schema: z.ZodTypeAny =
      kind === "object" ? z.object(shape) : kind === "strictObject" ? z.strictObject(shape) : kind === "looseObject" ? z.looseObject(shape) : z.object(shape).catchall(z.number());
    const wrappers = tc.draw(gs.arrays(gs.sampledFrom(WRAPPERS), { maxSize: 2 }));
    const undeclared = { zz: 1 } as never;
    for (const wrapper of wrappers) {
      const inner = schema as z.ZodObject;
      schema =
        wrapper === "optional" ? inner.optional() : wrapper === "nullable" ? inner.nullable() : wrapper === "readonly" ? inner.readonly() : wrapper === "prefault" ? inner.prefault({}) : wrapper === "default" ? inner.default(undeclared) : inner.catch(undeclared);
    }
    return { keys, kind, wrappers, schema };
  });

  it("names exactly the declared keys only when no value it parses keeps another key", () =>
    hegel.testAsync(async (tc) => {
      const { keys, schema } = tc.draw(objectSchemas);
      const named = closedObjectKeys(schema);
      if (named === null) return;
      expect([...named].sort()).toEqual([...keys].sort());
      const extra = tc.draw(gs.text({ alphabet: "abcz", minSize: 1, maxSize: 2 }));
      tc.assume(!keys.includes(extra));
      for (const input of [undefined, null, "x", {}, { [extra]: 1 }, { ...Object.fromEntries(keys.map((key) => [key, 1])), [extra]: 1 }]) {
        const parsed = schema.safeParse(input);
        if (!parsed.success || typeof parsed.data !== "object" || parsed.data === null) continue;
        expect(Object.keys(parsed.data).every((key) => keys.includes(key))).toBe(true);
      }
    }));

  it("names the keys of a z.object or a z.strictObject inside wrappers that parse, and of nothing that may keep another key", () =>
    hegel.testAsync(async (tc) => {
      const { kind, wrappers, schema } = tc.draw(objectSchemas);
      const closes = (kind === "object" || kind === "strictObject") && !wrappers.some((wrapper) => wrapper === "default" || wrapper === "catch");
      expect(closedObjectKeys(schema) !== null).toBe(closes);
    }));

  /** That object schema at a drawn path, each level a z.object around
   * the one below it inside drawn wrappers. A default or a catch on a
   * level holds a value whose object at the path's end has a key that
   * object does not declare. */
  const nestedSchemas = gs.composite((tc) => {
    const drawn = tc.draw(objectSchemas);
    const levels = tc.draw(gs.arrays(gs.tuples(gs.sampledFrom(["p", "q"]), gs.arrays(gs.sampledFrom(WRAPPERS), { maxSize: 2 })), { maxSize: 3 }));
    let schema = drawn.schema;
    let below: string[] = [];
    for (const [segment, wrappers] of levels) {
      const fallback = below.reduceRight<unknown>((value, key) => ({ [key]: value }), { zz: 1 }) as never;
      for (const wrapper of wrappers) {
        const inner = schema as z.ZodObject;
        schema =
          wrapper === "optional" ? inner.optional() : wrapper === "nullable" ? inner.nullable() : wrapper === "readonly" ? inner.readonly() : wrapper === "prefault" ? inner.prefault({}) : wrapper === "default" ? inner.default(fallback) : inner.catch(fallback);
      }
      schema = z.object({ [segment]: schema });
      below = [segment, ...below];
    }
    return { ...drawn, schema, segments: below, pathWrappers: levels.flatMap(([, wrappers]) => wrappers) };
  });

  it("names the keys of the object at a path only when no default or catch on the way keeps another key of it", () =>
    hegel.testAsync(async (tc) => {
      const { keys, kind, wrappers, schema, segments, pathWrappers } = tc.draw(nestedSchemas);
      const named = closedObjectKeysAt(schema, segments);
      const closes = (kind === "object" || kind === "strictObject") && ![...wrappers, ...pathWrappers].some((wrapper) => wrapper === "default" || wrapper === "catch");
      expect(named !== null).toBe(closes);
      if (named === null) return;
      expect([...named].sort()).toEqual([...keys].sort());
      // Each level missing or wrong in turn, so every default, catch, and
      // prefault on the path fills its value.
      for (let missing = 0; missing <= segments.length; missing += 1) {
        for (const leaf of [undefined, "x", { zz: 1 }]) {
          const input = segments.slice(0, missing).reduceRight<unknown>((value, key) => ({ [key]: value }), leaf);
          const parsed = schema.safeParse(input);
          if (!parsed.success) continue;
          const value = segments.reduce<unknown>((object, key) => (typeof object === "object" && object !== null ? (object as Record<string, unknown>)[key] : undefined), parsed.data);
          if (typeof value !== "object" || value === null) continue;
          expect(Object.keys(value).every((key) => keys.includes(key))).toBe(true);
        }
      }
    }));

  it("finds a value a default, a catch, a z.looseObject, or a catchall keeps another key of, so naming none of them is no guess", () => {
    const declared = { a: z.number() };
    const kept = (schema: z.ZodTypeAny, input: unknown) => Object.hasOwn(schema.parse(input) as object, "zz");
    expect(kept(z.object(declared).default({ a: 1, zz: 1 } as never), undefined)).toBe(true);
    expect(kept(z.object(declared).catch({ a: 1, zz: 1 } as never), "x")).toBe(true);
    expect(kept(z.looseObject(declared), { a: 1, zz: 1 })).toBe(true);
    expect(kept(z.object(declared).catchall(z.number()), { a: 1, zz: 1 })).toBe(true);
    expect(kept(z.object(declared), { a: 1, zz: 1 })).toBe(false);
    expect(z.strictObject(declared).safeParse({ a: 1, zz: 1 }).success).toBe(false);
  });
});

describe("a value nuka check knows is never an array", () => {
  /** A schema drawn from leaves, objects, arrays, and schemas the check
   * cannot read, inside unions and wrappers, with whether it can hold an
   * array as far as the drawing knows. */
  const schemas: Generator<z.ZodTypeAny> = gs.composite((tc) => {
    const leaf = (): z.ZodTypeAny => {
      const kind = tc.draw(gs.sampledFrom(["string", "number", "boolean", "null", "literal", "enum", "object", "record", "array", "tuple", "unknown", "transform", "lines"] as const));
      switch (kind) {
        case "string":
          return z.string();
        case "number":
          return z.number();
        case "boolean":
          return z.boolean();
        case "null":
          return z.null();
        case "literal":
          return z.literal(tc.draw(gs.sampledFrom(["a", 1, true, null] as const)));
        case "enum":
          return z.enum(["a", "b"]);
        case "object":
          return z.object({ a: z.number().optional() });
        case "record":
          return z.record(z.string(), z.number());
        case "array":
          return z.array(z.number());
        case "tuple":
          return z.tuple([z.number()]);
        case "unknown":
          return z.unknown();
        case "transform":
          return z.string().transform((text) => text);
        case "lines":
          return z.string().transform((text) => text.split("\n"));
      }
    };
    const wrap = (schema: z.ZodTypeAny): z.ZodTypeAny => {
      const wrapper = tc.draw(gs.sampledFrom(["none", "optional", "nullable", "readonly", "default", "catch"] as const));
      if (wrapper === "optional") return schema.optional();
      if (wrapper === "nullable") return schema.nullable();
      if (wrapper === "readonly") return schema.readonly();
      if (wrapper === "default") return schema.default([] as never);
      if (wrapper === "catch") return schema.catch([] as never);
      return schema;
    };
    const options = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
    const drawn = Array.from({ length: options }, () => wrap(leaf()));
    return wrap(drawn.length === 1 ? drawn[0]! : z.union(drawn as [z.ZodTypeAny, z.ZodTypeAny]));
  });
  const INPUTS: readonly unknown[] = [undefined, null, "a", "a\nb", 1, true, {}, { a: 1 }, [], [1], ["a"]];
  const nounOf = (value: unknown): string =>
    value === null ? "null" : value === undefined ? "undefined" : typeof value === "object" ? "an object" : typeof value === "string" ? "a string" : `a ${typeof value}`;

  it("names a schema never an array only when no value it parses is one, and names the type of every value it parses", () =>
    hegel.testAsync(async (tc) => {
      const schema = tc.draw(schemas);
      const nouns = nonArrayNouns(schema);
      if (nouns === null) return;
      for (const input of INPUTS) {
        const parsed = schema.safeParse(input);
        if (!parsed.success) continue;
        expect(Array.isArray(parsed.data)).toBe(false);
        expect(nouns).toContain(nounOf(parsed.data));
      }
    }));

  it("names every union of strings, numbers, booleans, nulls, literals, enums, objects, and records, inside wrappers that parse", () =>
    hegel.testAsync(async (tc) => {
      const parts = tc.draw(gs.arrays(gs.sampledFrom([z.string(), z.number(), z.boolean(), z.null(), z.literal("a"), z.enum(["a"]), z.object({}), z.record(z.string(), z.number())]), { minSize: 1, maxSize: 3 }));
      const union = parts.length === 1 ? parts[0]! : z.union(parts as unknown as [z.ZodTypeAny, z.ZodTypeAny]);
      const wrapper = tc.draw(gs.sampledFrom(["none", "optional", "nullable", "readonly"] as const));
      const schema = wrapper === "none" ? union : wrapper === "optional" ? union.optional() : wrapper === "nullable" ? union.nullable() : union.readonly();
      expect(nonArrayNouns(schema)).not.toBeNull();
    }));
});

const OUTCOMES = ["held", "broken", "unobserved", "unjudged"] as const;

function stepWith(outcomes: readonly (typeof OUTCOMES)[number][]): StepRecord {
  return { claims: outcomes.map((outcome) => ({ outcome })) } as unknown as StepRecord;
}

describe("a scenario entry's claims and judged_by", () => {
  it("counts every claim of the scenario's step records once, under its outcome", () =>
    hegel.testAsync(async (tc) => {
      const steps = tc.draw(gs.arrays(gs.oneOf<StepRecord | null>(gs.just(null), gs.arrays(gs.sampledFrom(OUTCOMES), { maxSize: 4 }).map(stepWith)), { maxSize: 5 }));
      const counts = scenarioClaims(steps);
      const all = steps.flatMap((step) => (step?.claims ?? []).map((claim) => claim.outcome));
      for (const outcome of OUTCOMES) {
        const n = all.filter((entry) => entry === outcome).length;
        if (outcome === "held" || outcome === "broken") expect(counts[outcome]).toBe(n);
        else expect(counts[outcome]).toBe(n === 0 ? undefined : n);
      }
    }));

  it("names no judge exactly when a claim on a Then line was judged, compat when none was and a compat step stands in Then position, and nothing otherwise", () =>
    hegel.testAsync(async (tc) => {
      const kinds = tc.draw(gs.arrays(gs.sampledFrom(["claim", "run", "compat", null, "undefined"] as const), { maxSize: 5 }));
      const then = tc.draw(gs.arrays(gs.booleans(), { minSize: kinds.length, maxSize: kinds.length }));
      // A claim step's record holds the outcomes it judged: none when it
      // never ran or its claims were empty, unobserved when observe threw.
      const records = kinds.map((kind) =>
        kind === "claim" ? tc.draw(gs.oneOf<StepRecord | null>(gs.just(null), gs.arrays(gs.sampledFrom(OUTCOMES), { maxSize: 3 }).map(stepWith))) : null,
      );
      const names = kinds.map((kind, index) => (kind === "undefined" ? null : `step${index}`));
      const kindOf = (name: string): "claim" | "run" | "compat" | null => {
        const kind = kinds[Number(name.slice(4))];
        return kind === "undefined" || kind === undefined ? null : kind;
      };
      const judged = judgedBy(names, (index) => then[index] ?? false, kindOf, records);
      const judgedOnThen = records.some((record, index) => then[index] && (record?.claims ?? []).some((claim) => claim.outcome !== "unobserved"));
      if (judgedOnThen) expect(judged).toBeUndefined();
      else if (kinds.some((kind, index) => kind === "compat" && then[index])) expect(judged).toBe("compat");
      else expect(judged).toBe("nothing");
    }));
});

describe("the literal nuka scaffold --then writes for a word", () => {
  const jsonTypeOf = (value: unknown): ChainedJsonType => (Array.isArray(value) ? "array" : typeof value === "string" ? "string" : typeof value === "number" ? "number" : null);

  it("is of the chained value's JSON type, one the literal rule accepts with the compare it writes, and there exactly when a word fixes a value of that type", () =>
    hegel.testAsync(async (tc) => {
      const words = tc.draw(gs.arrays(gs.sampledFrom(["the", "list", "is", "not", "shows", "{count:int}", "NO", "none", "nothing", "empty", "neither", "nor", "three", "Zero", "once", "Twice", "never", "constructor", "toString"]), { minSize: 1, maxSize: 5 }));
      const pattern = words.join(" ");
      const jsonType = tc.draw(gs.sampledFrom<ChainedJsonType>(["string", "number", "array", null]));
      const chosen = wordLiteral(pattern, jsonType);
      const shape = { patterns: [pattern], argsKeys: null, requiredArgsKeys: null, fromKeys: new Set(["got"]), captureKeys: new Set<string>(), hasObserve: false, rewrittenArgs: new Map(), stringArgs: null };
      // A word fixes a value of the type when the claim rule accepts that
      // value under one of the two compares a word allows.
      const accepted = (value: unknown) => (["equal", "not-equal"] as const).some((compare) => claimsProblem([{ actual: "got", compare, expected: { literal: value as never } }], shape) === null);
      const valuesOf = (word: string): readonly unknown[] => {
        const number = numberOfWord(word);
        return number === null ? tableValuesOf(word) : [number];
      };
      const fixesOne = words.some((word) => valuesOf(word).some((value) => jsonTypeOf(value) === jsonType && accepted(value)));
      expect(chosen !== null).toBe(jsonType !== null && fixesOne);
      if (chosen === null) return;
      expect(jsonTypeOf(chosen.literal)).toBe(jsonType);
      expect(valuesOf(chosen.word)).toContainEqual(chosen.literal);
      expect(literalStatedBy(pattern, chosen.literal)).not.toBeNull();
      expect(claimsProblem([{ actual: "got", compare: chosen.compare, expected: { literal: chosen.literal } }], shape)).toBeNull();
    }));

  it("writes no literal for a neither that a nor follows, and not-equal for a table word right after neither or nor", () => {
    expect(wordLiteral("the reply is neither blank nor whitespace", "string")).toBeNull();
    expect(wordLiteral("the reply is neither empty nor blank", "string")).toEqual({ word: "empty", literal: "", compare: "not-equal" });
    expect(wordLiteral("the reply is neither blank nor empty", "array")).toEqual({ word: "empty", literal: [], compare: "not-equal" });
    expect(wordLiteral("neither host path links to it any more", "array")).toEqual({ word: "neither", literal: [], compare: "equal" });
    expect(wordLiteral("the report has three lines", "number")).toEqual({ word: "three", literal: 3, compare: "equal" });
    expect(wordLiteral("the report has three lines", "string")).toBeNull();
  });
});
