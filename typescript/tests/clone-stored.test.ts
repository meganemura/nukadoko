import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Generator } from "@hegeldev/hegel/generators";
import { cloneForCaller } from "../src/context/clone-stored.js";

// Responsibility: `cloneForCaller` is the whole of the isolation `ctx.resultOf`
// and `ctx.call` promise. The property is that a caller can rewrite the value
// it was given, at any depth, and the stored value is unchanged. An example
// cannot say that for a shape it did not draw.

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

function spoil(value: unknown): void {
  if (Array.isArray(value)) {
    value.push("spoiled");
    for (const item of value) spoil(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const item of Object.values(record)) spoil(item);
    record.spoiled = true;
  }
}

describe("cloneForCaller", () => {
  it("returns undefined unchanged", () => {
    expect(cloneForCaller(undefined)).toBeUndefined();
  });

  it("copies a date instead of sharing it", () => {
    const stored = new Date("2020-01-02T00:00:00.000Z");
    const handed = cloneForCaller(stored);
    handed.setUTCFullYear(1999);
    expect(stored.toISOString()).toBe("2020-01-02T00:00:00.000Z");
    expect(handed).not.toBe(stored);
  });

  it("copies a cycle so the clone points at itself", () => {
    const stored: { self?: unknown } = {};
    stored.self = stored;
    const handed = cloneForCaller(stored);
    expect(handed).not.toBe(stored);
    expect(handed.self).toBe(handed);
    expect(stored.self).toBe(stored);
  });

  it("deep-equals the stored value, and spoiling the copy leaves the stored value", () =>
    hegel.test((tc) => {
      const stored = tc.draw(jsonValues);
      const before = structuredClone(stored);
      const handed = cloneForCaller(stored);
      expect(handed).toEqual(before);
      if (handed !== null && typeof handed === "object") {
        expect(handed).not.toBe(stored);
        spoil(handed);
        expect(stored).toEqual(before);
      }
    }));
});
