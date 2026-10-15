import type { Draw } from "../step/define-explore.js";

// Responsibility: the list of choices a generated sequence is made from.
// A run draws each choice from a seeded generator and records it. A shrink
// attempt replays an edited list. The model, its command order, and its
// `args` callbacks see the same `Draw` either way, so a sequence is a pure
// function of its choices, and shrinking edits choices rather than steps.
// This file does not know what a step or a model is.

/** mulberry32: small, fast, and the same on every platform, so a printed
 * seed reruns the same choices anywhere. Not for anything cryptographic. */
export function seededUint32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export interface ChoiceSource {
  /** A whole number in `[0, bound)`. `bound` is at least 1. */
  choose(bound: number): number;
  /** True when a replayed list has no choice left. A generated source is
   * never exhausted. */
  exhausted(): boolean;
  /** Every choice handed out so far, in order. */
  readonly used: readonly number[];
}

export function generatedSource(next: () => number): ChoiceSource {
  const used: number[] = [];
  return {
    choose(bound) {
      const value = next() % bound;
      used.push(value);
      return value;
    },
    exhausted: () => false,
    used,
  };
}

/** A choice past the end of the list is 0, and a choice too large for its
 * bound is the largest one allowed. Both keep a shrunk list meaningful
 * after an earlier edit changed what a later choice is for. */
export function replayedSource(choices: readonly number[]): ChoiceSource {
  const used: number[] = [];
  let position = 0;
  return {
    choose(bound) {
      const recorded = position < choices.length ? choices[position]! : 0;
      position += 1;
      const value = Math.min(recorded, bound - 1);
      used.push(value);
      return value;
    },
    exhausted: () => position >= choices.length,
    used,
  };
}

export function drawFrom(source: ChoiceSource): Draw {
  return {
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min || max - min >= 2 ** 32) {
        throw new RangeError(
          `draw.int(${min}, ${max}) needs two whole numbers with min <= max, at most 2^32 values apart`,
        );
      }
      return min + source.choose(max - min + 1);
    },
    pick(items) {
      if (items.length === 0) {
        throw new RangeError("draw.pick([]) has nothing to pick");
      }
      return items[source.choose(items.length)]!;
    },
  };
}
