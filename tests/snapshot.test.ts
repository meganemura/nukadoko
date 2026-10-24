import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Generator } from "@hegeldev/hegel/generators";
import { deepEqual } from "../src/step/evaluate-claims.js";
import { copyOf, inputCopy, readAt, snapshot, snapshotKeys, SNAPSHOT_MAX_DEPTH } from "../src/step/snapshot.js";

// Responsibility: the one plain copy a claim judges and its record shows
// (docs/spec.md "Claims"), as properties over drawn values: every JSON
// value copies to an equal value that shares no object with it, and a
// copy of a copy is the copy; every value with a part that is not plain
// JSON, a Proxy at any depth, or a value nested past the limit is refused,
// naming where; and reading a path runs no code of the value's own.

const keyGen = gs.sampledFrom(["a", "b", "__proto__", "0", "constructor"]);

function jsonValue(depth: number): Generator<unknown> {
  const leaf = gs.oneOf<unknown>(
    gs.just(null),
    gs.booleans(),
    gs.integers({ minValue: -30, maxValue: 30 }),
    gs.floats({ minValue: -1, maxValue: 1, allowNan: false, allowInfinity: false }),
    gs.text({ alphabet: "ab\"", maxSize: 3 }),
  );
  if (depth === 0) return leaf;
  const child = jsonValue(depth - 1);
  return gs.oneOf<unknown>(
    leaf,
    gs.arrays(child, { maxSize: 3 }),
    gs.composite((tc) => {
      // JSON.parse is how a value with an own `__proto__` key arrives, and
      // a null prototype is how a dictionary does.
      const obj: Record<string, unknown> = tc.draw(gs.booleans()) ? Object.create(null) : {};
      const count = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
      for (let i = 0; i < count; i++) {
        Object.defineProperty(obj, tc.draw(keyGen), { value: tc.draw(child), enumerable: true, writable: true, configurable: true });
      }
      return obj;
    }),
  );
}

const jsonValues = jsonValue(3);

/** Every object and array inside `value`, the root included. */
function objectsOf(value: unknown, into: Set<object> = new Set()): Set<object> {
  if (typeof value === "object" && value !== null) {
    into.add(value);
    for (const key of Object.keys(value)) objectsOf((value as Record<string, unknown>)[key], into);
  }
  return into;
}

/** How many containers deep `value` nests: 0 for a scalar, 1 for `[]`. */
function depthOf(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  return 1 + Math.max(0, ...Object.keys(value).map((key) => depthOf((value as Record<string, unknown>)[key])));
}

/** A JSON value with `part` put inside it, and the path to the part. */
function withPart(part: () => unknown): Generator<{ value: unknown; at: string[] }> {
  return gs.composite((tc) => {
    let value = part();
    const at: string[] = [];
    const levels = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
    for (let level = 0; level < levels; level += 1) {
      if (tc.draw(gs.booleans())) {
        const before = tc.draw(gs.arrays(jsonValue(1), { maxSize: 2 }));
        value = [...before, value];
        at.unshift(String(before.length));
      } else {
        value = { x: tc.draw(jsonValue(1)), y: value };
        at.unshift("y");
      }
    }
    return { value, at };
  });
}

const nonJsonParts: Generator<{ make: () => unknown; problem: string }> = gs.sampledFrom([
  { make: () => Number.NaN, problem: "is NaN" },
  { make: () => 2 ** 60, problem: "is the integer 1152921504606847000, beyond Number.MAX_SAFE_INTEGER" },
  { make: () => 12n, problem: "is the bigint 12n" },
  { make: () => () => 1, problem: "is a function" },
  { make: () => new Date(0), problem: "is a Date" },
  { make: () => new (class Order {})(), problem: "is an Order" },
  { make: () => new Proxy({ a: 1 }, {}), problem: "is a Proxy" },
  { make: () => new Proxy([1], {}), problem: "is a Proxy" },
]);

function holdsUndefinedKey(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([, entry]) => entry === undefined || holdsUndefinedKey(entry));
}

describe("snapshot", () => {
  it("copies every JSON value to an equal value that shares no object with it", () =>
    hegel.test((tc) => {
      const value = tc.draw(jsonValues);
      const taken = snapshot(value);
      expect("value" in taken).toBe(true);
      const copy = (taken as { value: unknown }).value;
      expect(deepEqual(copy, value)).toBe(true);
      expect(JSON.stringify(copy)).toBe(JSON.stringify(value));
      const original = objectsOf(value);
      for (const object of objectsOf(copy)) expect(original.has(object)).toBe(false);
    }));

  it("copies a copy to the copy", () =>
    hegel.test((tc) => {
      const once = snapshot(tc.draw(jsonValues)) as { value: unknown };
      const twice = snapshot(once.value) as { value: unknown };
      expect(twice).toEqual({ value: once.value });
      expect(JSON.stringify(twice.value)).toBe(JSON.stringify(once.value));
    }));

  it("refuses a value with a part that is not plain JSON, a Proxy at any depth included, and names where it sits", () =>
    hegel.test((tc) => {
      const part = tc.draw(nonJsonParts);
      const { value, at } = tc.draw(withPart(part.make));
      expect(snapshot(value)).toEqual({ refused: { at, problem: part.problem } });
    }));

  it("leaves out an object key whose value is undefined, as the record's JSON does, and refuses an array item that is undefined", () =>
    hegel.test((tc) => {
      const { value } = tc.draw(withPart(() => ({ kept: 1, unset: undefined })));
      const taken = snapshot(value);
      // JSON.stringify leaves an undefined key out and writes -0 as 0, as
      // the record does, so the copy's JSON is the value's, and the copy
      // holds no undefined key of its own either.
      expect("value" in taken).toBe(true);
      const copy = (taken as { value: unknown }).value;
      expect(JSON.stringify(copy)).toBe(JSON.stringify(value));
      expect(holdsUndefinedKey(copy)).toBe(false);
      const inArray = tc.draw(withPart(() => [undefined]));
      expect(snapshot(inArray.value)).toEqual({ refused: { at: [...inArray.at, "0"], problem: "is undefined" } });
    }));

  it("refuses a value exactly when it nests deeper than the limit, and names the limit", () =>
    hegel.test((tc) => {
      const limit = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
      const value = tc.draw(jsonValue(5));
      const taken = snapshot(value, limit);
      if (depthOf(value) <= limit) expect("value" in taken).toBe(true);
      else expect(taken).toEqual({ refused: { at: [], problem: `nests deeper than ${limit} levels`, limit } });
    }));

  it("refuses a value deeper than the default limit, and takes one at it", () => {
    const nest = (levels: number): unknown => {
      let value: unknown = 0;
      for (let level = 0; level < levels; level += 1) value = [value];
      return value;
    };
    expect("value" in snapshot(nest(SNAPSHOT_MAX_DEPTH))).toBe(true);
    expect(snapshot(nest(SNAPSHOT_MAX_DEPTH + 1))).toMatchObject({ refused: { problem: `nests deeper than ${SNAPSHOT_MAX_DEPTH} levels` } });
  });
});

describe("readAt", () => {
  it("reads a path through own data properties and takes the snapshot of what it reaches", () =>
    hegel.test((tc) => {
      const value = tc.draw(jsonValues);
      const root = { r: value };
      const segments = ["r"];
      let current: unknown = value;
      while (typeof current === "object" && current !== null && Object.keys(current).length > 0 && tc.draw(gs.booleans())) {
        const key = tc.draw(gs.sampledFrom(Object.keys(current)));
        segments.push(key);
        current = (current as Record<string, unknown>)[key];
      }
      const read = readAt(root, segments);
      expect("value" in read && deepEqual(read.value, current)).toBe(true);
      expect(readAt(root, [...segments, "zz"])).toEqual({ missing: segments.length });
    }));

  it("runs no getter and no Proxy trap on the way, and refuses both", () => {
    let calls = 0;
    const trap = new Proxy({ list: ["milk"] }, {
      get: () => (calls += 1),
      getOwnPropertyDescriptor: () => {
        calls += 1;
        throw new Error("trap ran");
      },
      getPrototypeOf: () => {
        calls += 1;
        return null;
      },
      ownKeys: () => {
        calls += 1;
        return [];
      },
    });
    const getter = Object.defineProperty({}, "list", { get: () => (calls += 1), enumerable: true });
    expect(readAt({ v: trap }, ["v", "list"])).toEqual({ refused: { at: ["v"], problem: "is a Proxy" } });
    expect(readAt(trap, [])).toEqual({ refused: { at: [], problem: "is a Proxy" } });
    expect(readAt({ v: getter }, ["v", "list", "0"])).toEqual({ refused: { at: ["v", "list"], problem: "is a getter" } });
    expect(readAt({ v: { w: getter } }, ["v"])).toEqual({ refused: { at: ["v", "w", "list"], problem: "is a getter" } });
    expect(calls).toBe(0);
  });

  it("finds nothing at a segment that names an Object.prototype member", () => {
    expect(readAt({ cart: { items: [] } }, ["cart", "constructor"])).toEqual({ missing: 1 });
    expect(readAt({ cart: { items: [] } }, ["cart", "items", "length"])).toEqual({ missing: 2 });
    expect(readAt({ cart: {} }, ["cart", "__proto__"])).toEqual({ missing: 1 });
  });
});

describe("snapshotKeys and copyOf", () => {
  it("takes each key of a result so that nothing done to the result or to one copy reaches another copy", () =>
    hegel.test((tc) => {
      const value = tc.draw(jsonValues);
      const result: Record<string, unknown> = { items: [value], other: value };
      const before = JSON.stringify(result);
      const taken = snapshotKeys(result);
      (result["items"] as unknown[]).push("changed");
      result["other"] = "changed";
      const items = taken.get("items")!;
      if (!("value" in items)) throw new Error("refused");
      const first = copyOf(items) as unknown[];
      first.push("changed too");
      const second = copyOf(items);
      expect(JSON.stringify(second)).toBe(JSON.stringify((JSON.parse(before) as Record<string, unknown>)["items"]));
      expect(deepEqual(copyOf(taken.get("other") as { value: unknown }), value)).toBe(true);
    }));

  it("leaves out a key whose value is undefined, refuses a getter without calling it, and has no keys for a result that is not an object", () => {
    let called = false;
    const result = Object.defineProperty({ gone: undefined, when: new Date(0) }, "lazy", {
      get() {
        called = true;
        return 1;
      },
      enumerable: true,
    });
    const taken = snapshotKeys(result);
    expect([...taken.keys()]).toEqual(["when", "lazy"]);
    expect(taken.get("when")).toEqual({ refused: { at: [], problem: "is a Date" } });
    expect(taken.get("lazy")).toEqual({ refused: { at: [], problem: "is a getter" } });
    expect(called).toBe(false);
    expect(snapshotKeys(3).size).toBe(0);
    expect(snapshotKeys(new Proxy({ a: 1 }, {})).size).toBe(0);
  });
});

describe("inputCopy", () => {
  it("copies an input so that changing the copy leaves the value as it was", () =>
    hegel.test((tc) => {
      const value = { v: tc.draw(jsonValues), when: new Date(0), tags: new Set(["a"]) };
      const before = JSON.stringify(value);
      const copied = inputCopy(value);
      if (!("value" in copied)) throw new Error(copied.problem);
      const copy = copied.value as typeof value;
      (copy as Record<string, unknown>)["v"] = "changed";
      copy.when.setTime(5);
      copy.tags.add("b");
      expect(JSON.stringify(value)).toBe(before);
      expect(value.tags.size).toBe(1);
    }));

  it("names a Proxy, a function, and a class instance that holds one as what cannot be copied", () => {
    class Client {
      send = (): number => 1;
    }
    expect(inputCopy(new Proxy({ a: 1 }, {}))).toEqual({ problem: "is a Proxy" });
    expect(inputCopy(() => 1)).toEqual({ problem: "is a function" });
    expect(inputCopy(new Client())).toEqual({ problem: "holds a function at send" });
    expect(inputCopy({ list: [new Proxy([], {})] })).toEqual({ problem: "holds a Proxy at list.0" });
    expect(inputCopy(new WeakMap())).toMatchObject({ problem: expect.stringMatching(/^is a WeakMap, which a structured clone cannot copy \(/) });
  });
});
