import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Generator } from "@hegeldev/hegel/generators";
import { certainlySamePlace } from "../src/check/claim-check.js";
import { statedWord } from "../src/cli/scaffold.js";
import type { ClaimReading, StepRecord } from "../src/record/types.js";
import { judgedBy, scenarioClaims } from "../src/run/run-document.js";
import { ANY_INDEX, LITERAL_WORDS, literalStatedBy } from "../src/step/claims.js";
import { CLAIM_READING_MAX_BYTES, createReadingsLog, failedReading, readingValue } from "../src/step/evaluate-claims.js";

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

function reading(attempt: number): ClaimReading {
  return { attempt, at: `2026-01-01T00:00:00.${String(attempt).padStart(3, "0")}Z`, held: false };
}

describe("the readings a poll keeps", () => {
  it("keeps the first head readings and the last tail ones, in the order they came", () =>
    hegel.testAsync(async (tc) => {
      const head = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
      const tail = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
      const count = tc.draw(gs.integers({ minValue: 0, maxValue: 15 }));
      const log = createReadingsLog(head, tail);
      for (let attempt = 1; attempt <= count; attempt++) log.add(reading(attempt));
      const kept = log.kept().map((entry) => entry.attempt);
      const first = Math.min(head, count);
      const last = Math.min(tail, count - first);
      const want = [
        ...Array.from({ length: first }, (_, index) => index + 1),
        ...Array.from({ length: last }, (_, index) => count - last + index + 1),
      ];
      expect(kept).toEqual(want);
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

  it("names no judge when a claim step is bound, compat when only a compat step stands in Then position, and nothing otherwise", () =>
    hegel.testAsync(async (tc) => {
      const kinds = tc.draw(gs.arrays(gs.sampledFrom(["claim", "run", "compat", null, "undefined"] as const), { maxSize: 5 }));
      const then = tc.draw(gs.arrays(gs.booleans(), { minSize: kinds.length, maxSize: kinds.length }));
      const names = kinds.map((kind, index) => (kind === "undefined" ? null : `step${index}`));
      const kindOf = (name: string): "claim" | "run" | "compat" | null => {
        const kind = kinds[Number(name.slice(4))];
        return kind === "undefined" || kind === undefined ? null : kind;
      };
      const judged = judgedBy(names, (index) => then[index] ?? false, kindOf);
      if (kinds.includes("claim")) expect(judged).toBeUndefined();
      else if (kinds.some((kind, index) => kind === "compat" && then[index])) expect(judged).toBe("compat");
      else expect(judged).toBe("nothing");
    }));
});

describe("the literal nuka scaffold --then writes for a word", () => {
  it("is one the literal rule accepts for the same pattern", () =>
    hegel.testAsync(async (tc) => {
      const words = tc.draw(gs.arrays(gs.sampledFrom(["the", "list", "is", "shows", "{count:int}", "NO", "none", "nothing", "empty"]), { minSize: 1, maxSize: 5 }));
      const pattern = words.join(" ");
      const actualClass = tc.draw(gs.sampledFrom(["string", "number", "other"] as const));
      const stated = statedWord(pattern, actualClass);
      const hasWord = words.some((word) => LITERAL_WORDS[word.toLowerCase()] !== undefined);
      expect(stated !== null).toBe(hasWord);
      if (stated === null) return;
      expect(LITERAL_WORDS[stated.word.toLowerCase()]).toContainEqual(stated.literal);
      expect(literalStatedBy(pattern, stated.literal)).not.toBeNull();
    }));
});
