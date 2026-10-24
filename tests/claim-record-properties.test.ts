import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Generator } from "@hegeldev/hegel/generators";
import { certainlySamePlace } from "../src/check/claim-check.js";
import { type ChainedJsonType, wordLiteral } from "../src/cli/scaffold.js";
import type { ClaimReading, StepRecord } from "../src/record/types.js";
import { judgedBy, scenarioClaims } from "../src/run/run-document.js";
import { ANY_INDEX, claimsProblem, LITERAL_WORDS, literalStatedBy } from "../src/step/claims.js";
import { CLAIM_READING_MAX_BYTES, CLAIM_READINGS_CAP, failedReading, keptReadings, readingValue } from "../src/step/evaluate-claims.js";

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

  it("names no judge when a claim step stands in Then position, compat when only a compat step does, and nothing otherwise, wherever else a claim step stands", () =>
    hegel.testAsync(async (tc) => {
      const kinds = tc.draw(gs.arrays(gs.sampledFrom(["claim", "run", "compat", null, "undefined"] as const), { maxSize: 5 }));
      const then = tc.draw(gs.arrays(gs.booleans(), { minSize: kinds.length, maxSize: kinds.length }));
      const names = kinds.map((kind, index) => (kind === "undefined" ? null : `step${index}`));
      const kindOf = (name: string): "claim" | "run" | "compat" | null => {
        const kind = kinds[Number(name.slice(4))];
        return kind === "undefined" || kind === undefined ? null : kind;
      };
      const judged = judgedBy(names, (index) => then[index] ?? false, kindOf);
      if (kinds.some((kind, index) => kind === "claim" && then[index])) expect(judged).toBeUndefined();
      else if (kinds.some((kind, index) => kind === "compat" && then[index])) expect(judged).toBe("compat");
      else expect(judged).toBe("nothing");
    }));
});

describe("the literal nuka scaffold --then writes for a word", () => {
  const jsonTypeOf = (value: unknown): ChainedJsonType => (Array.isArray(value) ? "array" : typeof value === "string" ? "string" : typeof value === "number" ? "number" : null);

  it("is of the chained value's JSON type, one the literal rule accepts with the compare it writes, and there exactly when a word fixes a value of that type", () =>
    hegel.testAsync(async (tc) => {
      const words = tc.draw(gs.arrays(gs.sampledFrom(["the", "list", "is", "not", "shows", "{count:int}", "NO", "none", "nothing", "empty"]), { minSize: 1, maxSize: 5 }));
      const pattern = words.join(" ");
      const jsonType = tc.draw(gs.sampledFrom<ChainedJsonType>(["string", "number", "array", null]));
      const chosen = wordLiteral(pattern, jsonType);
      const fixesOne = words.some((word) => (LITERAL_WORDS[word.toLowerCase()] ?? []).some((value) => jsonTypeOf(value) === jsonType));
      expect(chosen !== null).toBe(jsonType !== null && fixesOne);
      if (chosen === null) return;
      expect(jsonTypeOf(chosen.literal)).toBe(jsonType);
      expect(LITERAL_WORDS[chosen.word.toLowerCase()]).toContainEqual(chosen.literal);
      expect(literalStatedBy(pattern, chosen.literal)).not.toBeNull();
      const shape = { patterns: [pattern], argsKeys: null, requiredArgsKeys: null, fromKeys: new Set(["got"]), captureKeys: new Set<string>(), hasObserve: false, rewrittenArgs: new Map(), stringArgs: null };
      expect(claimsProblem([{ actual: "got", compare: chosen.compare, expected: { literal: chosen.literal } }], shape)).toBeNull();
    }));
});
