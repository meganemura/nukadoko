import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Generator } from "@hegeldev/hegel/generators";
import { freezeInPlace, frozenCopy } from "../src/step/frozen-copy.js";

// Responsibility: the one copy of a step definition's data that defineStep
// validates and the run reads (docs/spec.md "The shape"), as properties
// over drawn definitions: every plain value copies to an equal value that
// is frozen at every level and shares no object with the value it came
// from, except a function or a kept value; a part that is not plain data,
// at any depth, is refused with its path; and freezing in place reaches
// below an object that was frozen already.

const kept = new WeakSet<object>();
const keep = (value: object): boolean => kept.has(value);

const keyGen = gs.sampledFrom(["a", "b", "__proto__", "0", "constructor", "my key"]);

function plainValue(depth: number): Generator<unknown> {
  const leaf = gs.oneOf<unknown>(
    gs.just(null),
    gs.just(undefined),
    gs.booleans(),
    gs.integers({ minValue: -30, maxValue: 30 }),
    gs.text({ alphabet: "ab\"", maxSize: 3 }),
    gs.composite(() => () => 1),
    gs.composite(() => {
      const step = { step: true };
      kept.add(step);
      return step;
    }),
  );
  if (depth === 0) return leaf;
  const child = plainValue(depth - 1);
  return gs.oneOf<unknown>(
    leaf,
    gs.arrays(child, { maxSize: 3 }),
    gs.composite((tc) => {
      const obj: Record<string, unknown> = tc.draw(gs.booleans()) ? Object.create(null) : {};
      const count = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
      for (let i = 0; i < count; i++) {
        Object.defineProperty(obj, tc.draw(keyGen), { value: tc.draw(child), enumerable: true, writable: true, configurable: true });
      }
      return obj;
    }),
  );
}

const plainValues = plainValue(3);

/** Every array and plain object inside `value`, the root included, not
 * counting kept values or anything inside them. */
function containersOf(value: unknown, into: Set<object> = new Set()): Set<object> {
  if (typeof value === "object" && value !== null && !keep(value)) {
    into.add(value);
    for (const key of Object.keys(value)) containersOf((value as Record<string, unknown>)[key], into);
  }
  return into;
}

/** True when `a` and `b` hold the same keys, prototypes, and leaves, with a
 * function or a kept value the same one on both sides. */
function sameData(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || a === null || keep(a)) return Object.is(a, b);
  if (typeof b !== "object" || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b) || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length || keysA.some((key, index) => key !== keysB[index])) return false;
  return keysA.every((key) => sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Freezes some of the containers inside `value`, the way a step file that
 * writes `Object.freeze([...])` does. */
function freezeSome(value: unknown, pick: () => boolean): void {
  if (typeof value !== "object" || value === null || keep(value)) return;
  for (const key of Object.keys(value)) freezeSome((value as Record<string, unknown>)[key], pick);
  if (pick()) Object.freeze(value);
}

/** A plain value with `part` put inside it, and the path the copy names. */
function withPart(part: () => object): Generator<{ value: unknown; path: string; parent: object }> {
  return gs.composite((tc) => {
    const parent: Record<string, unknown> = { p: 1 };
    Object.defineProperty(parent, "x", { ...describePart(part()), enumerable: true, configurable: true });
    let value: unknown = parent;
    let path = ".x";
    const levels = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
    for (let level = 0; level < levels; level += 1) {
      if (tc.draw(gs.booleans())) {
        const before = tc.draw(gs.arrays(plainValue(1), { maxSize: 2 }));
        path = `[${before.length}]${path}`;
        value = [...before, value];
      } else {
        path = `.claims${path}`;
        value = { other: tc.draw(plainValue(1)), claims: value };
      }
    }
    return { value, path: `root${path}`, parent };
  });
}

/** The property descriptor a drawn part stands for: a getter or a setter
 * is a descriptor; anything else is the value of a data property. */
function describePart(part: object): PropertyDescriptor {
  return "descriptor" in part ? (part as { descriptor: PropertyDescriptor }).descriptor : { value: part, writable: true };
}

const refusedParts: Generator<{ make: () => object; problem: string; at: string }> = gs.sampledFrom([
  { make: () => ({ descriptor: { get: () => "equal" } }), problem: "is a getter or a setter", at: "" },
  { make: () => ({ descriptor: { set: () => undefined } }), problem: "is a getter or a setter", at: "" },
  { make: () => new Proxy({ compare: "equal" }, {}), problem: "is a Proxy", at: "" },
  { make: () => new Proxy([1], {}), problem: "is a Proxy", at: "" },
  { make: () => new Date(0), problem: "is an object of the class Date, not plain data", at: "" },
  { make: () => new (class Claim {})(), problem: "is an object of the class Claim, not plain data", at: "" },
  { make: () => new Map(), problem: "is an object of the class Map, not plain data", at: "" },
  { make: () => ({ inner: Object.defineProperty({}, "compare", { get: () => "equal", enumerable: true }) }), problem: "is a getter or a setter", at: ".inner.compare" },
]);

describe("frozenCopy", () => {
  it("copies plain data to an equal value, frozen at every level, that shares only functions and kept values", () =>
    hegel.test((tc) => {
      const value = tc.draw(plainValues);
      const copied = frozenCopy(value, "root", keep);
      expect("value" in copied).toBe(true);
      const copy = (copied as { value: unknown }).value;
      expect(sameData(value, copy)).toBe(true);
      const original = containersOf(value);
      for (const container of containersOf(copy)) {
        expect(Object.isFrozen(container)).toBe(true);
        expect(original.has(container)).toBe(false);
      }
    }));

  it("freezes every level of the copy even where the step file froze its own object first", () =>
    hegel.test((tc) => {
      const value = tc.draw(plainValues);
      freezeSome(value, () => tc.draw(gs.booleans()));
      const before = [...containersOf(value)].map((container) => Object.isFrozen(container));
      const copy = (frozenCopy(value, "root", keep) as { value: unknown }).value;
      for (const container of containersOf(copy)) expect(Object.isFrozen(container)).toBe(true);
      // The copy freezes only itself; the step file's objects are as they were.
      expect([...containersOf(value)].map((container) => Object.isFrozen(container))).toEqual(before);
    }));

  it("refuses a getter, a setter, a Proxy, or an object of a class at any depth, and names its path", () =>
    hegel.test((tc) => {
      const part = tc.draw(refusedParts);
      const { value, path } = tc.draw(withPart(part.make));
      expect(frozenCopy(value, "root", keep)).toEqual({ refused: { path: `${path}${part.at}`, problem: part.problem } });
    }));

  it("refuses a value that holds itself, and copies a value reached twice by two paths", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop["self"] = [loop];
    expect(frozenCopy(loop, "claims", keep)).toEqual({ refused: { path: "claims.self[0]", problem: "holds itself" } });
    const shared = { compare: "equal" };
    const copied = frozenCopy([shared, shared], "claims", keep) as { value: unknown[] };
    expect(copied.value).toEqual([{ compare: "equal" }, { compare: "equal" }]);
  });

  it("names a key that is not an identifier in brackets, the way a step file writes it", () => {
    const getter = Object.defineProperty({}, "my key", { get: () => 1, enumerable: true });
    expect(frozenCopy({ a: [getter] }, "claims", keep)).toEqual({ refused: { path: 'claims.a[0]["my key"]', problem: "is a getter or a setter" } });
  });
});

describe("freezeInPlace", () => {
  it("freezes every array and plain object inside a value, below one that was frozen already, and leaves kept values alone", () =>
    hegel.test((tc) => {
      const value = tc.draw(plainValues);
      freezeSome(value, () => tc.draw(gs.booleans()));
      const step = { step: true };
      kept.add(step);
      const root = { value, step };
      freezeInPlace(root, keep);
      for (const container of containersOf(root)) expect(Object.isFrozen(container)).toBe(true);
      expect(Object.isFrozen(step)).toBe(false);
    }));
});
