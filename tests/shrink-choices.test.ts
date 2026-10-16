import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { shrinkChoices, type Shrinkable } from "../src/explore/shrink.js";

// Responsibility: whatever the failure predicate, a shrink never returns a
// longer choice list than it started from, never makes more attempts than
// its limit, and returns a list that still fails.

function oneSpanEach(choices: readonly number[]): Shrinkable {
  return { choices, spans: choices.map((_, index) => [index, index + 1] as const) };
}

describe("shrinkChoices", () => {
  it("returns a failing list no longer than the first, within the attempt limit", () =>
    hegel.testAsync(async (tc) => {
      const choices = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 50 }), { minSize: 1, maxSize: 12 }));
      const threshold = tc.draw(gs.integers({ minValue: 0, maxValue: 100 }));
      const limit = tc.draw(gs.integers({ minValue: 0, maxValue: 40 }));
      const fails = (list: readonly number[]): boolean => list.reduce((sum, value) => sum + value, 0) >= threshold;
      if (!fails(choices)) return;
      let calls = 0;
      const { best, attempts } = await shrinkChoices(
        oneSpanEach(choices),
        async (candidate) => {
          calls += 1;
          return fails(candidate) ? oneSpanEach(candidate) : undefined;
        },
        limit,
      );
      expect(best.choices.length).toBeLessThanOrEqual(choices.length);
      expect(attempts).toBeLessThanOrEqual(limit);
      expect(calls).toBe(attempts);
      expect(fails(best.choices)).toBe(true);
    }));

  it("shrinks a sum threshold to the shortest list that reaches it", async () => {
    const { best } = await shrinkChoices(
      oneSpanEach([3, 9, 4, 7]),
      async (candidate) => (candidate.reduce((sum, value) => sum + value, 0) >= 10 ? oneSpanEach(candidate) : undefined),
    );
    expect(best.choices).toEqual([3, 7]);
  });
});
