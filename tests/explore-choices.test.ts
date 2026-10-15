import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { drawFrom, generatedSource, replayedSource, seededUint32 } from "../src/explore/choices.js";

// Responsibility: the choice list a sequence is built from. A replay of
// what a run used gives back the same values, a replayed choice is clamped
// to its bound, a choice past the end is 0, and draw rejects a range or a
// list it cannot draw from.

describe("replayedSource", () => {
  it("clamps a recorded choice that is too large for its bound", () => {
    const source = replayedSource([7, 2]);
    expect(source.choose(3)).toBe(2);
    expect(source.choose(10)).toBe(2);
    expect(source.used).toEqual([2, 2]);
  });

  it("gives 0 past the end of the list, and says when it is exhausted", () => {
    const source = replayedSource([4]);
    expect(source.exhausted()).toBe(false);
    expect(source.choose(9)).toBe(4);
    expect(source.exhausted()).toBe(true);
    expect(source.choose(9)).toBe(0);
    expect(source.used).toEqual([4, 0]);
  });

  it("gives back the choices a generated run used, for any seed and bounds", () =>
    hegel.test((tc) => {
      const seed = tc.draw(gs.integers({ minValue: 0, maxValue: 2 ** 32 - 1 }));
      const bounds = tc.draw(gs.arrays(gs.integers({ minValue: 1, maxValue: 1000 }), { minSize: 0, maxSize: 20 }));
      const generated = generatedSource(seededUint32(seed));
      const values = bounds.map((bound) => generated.choose(bound));
      const replayed = replayedSource(generated.used);
      expect(bounds.map((bound) => replayed.choose(bound))).toEqual(values);
      expect(replayed.used).toEqual(generated.used);
    }));
});

describe("drawFrom", () => {
  it("draws int from min upward, so a lower choice is a value nearer min", () => {
    const draw = drawFrom(replayedSource([0, 3]));
    expect(draw.int(10, 20)).toBe(10);
    expect(draw.int(-5, 5)).toBe(-2);
  });

  it("picks by position", () => {
    expect(drawFrom(replayedSource([1])).pick(["a", "b", "c"])).toBe("b");
  });

  it("refuses an int range it cannot draw from", () => {
    const draw = drawFrom(replayedSource([]));
    expect(() => draw.int(5, 4)).toThrow(
      new RangeError("draw.int(5, 4) needs two whole numbers with min <= max, at most 2^32 values apart"),
    );
    expect(() => draw.int(0.5, 4)).toThrow(RangeError);
    expect(() => draw.int(0, 2 ** 32)).toThrow(RangeError);
  });

  it("refuses to pick from an empty list", () => {
    expect(() => drawFrom(replayedSource([])).pick([])).toThrow(new RangeError("draw.pick([]) has nothing to pick"));
  });
});
