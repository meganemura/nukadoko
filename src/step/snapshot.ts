import { types } from "node:util";

// Responsibility: the one plain copy of a value that a claim judges and its
// record shows (docs/spec.md "Claims"). `snapshot` walks a value once and
// returns either a fresh copy made only of plain JSON, sharing no object
// with the value it was given, or a refusal that names where the first part
// that is not plain JSON sits and what it is. `readAt` walks a path to the
// value a claim names and takes its snapshot, and `snapshotKeys` takes one
// of each key of a step's result. They are pure and run no code of the
// value's own: a getter is refused by its descriptor, never called, and a
// Proxy is refused before any of its traps can run. `inputCopy` is the one
// copy here that may run code (a structured clone calls getters): it makes
// what `observe` receives, which no claim reads.
//
// Why one copy: a claim used to read the live value step code returned, so
// the value that was compared and the value the record showed were two
// reads of an object step code still held. A Proxy answered a compare one
// way and the record another, `observe` could change its input after
// returning it, a timer could change a returned array before the record
// was written, and a poll that returned one array each time showed its last
// value on every reading. A snapshot taken where the value comes from, and
// read from then on, makes what was compared and what is recorded one
// value. The module does not decide when to take one (the runner does) and
// does not judge anything.

/** The deepest a value may nest, in containers from the snapshot's root: a
 * value that passes is written into the step record, run.json, the
 * summary, and the Allure and messages output, and some of the functions
 * that write it recurse once per level. Measured on Node 22.22 with nested
 * arrays that `observe` returned: a run overflowed the stack at 1650
 * levels, in the redaction of the step record, which recurses through
 * `Array.map` and so spends more than one frame per level. 256 keeps a
 * margin of six times for a caller that starts deeper in the stack. */
export const SNAPSHOT_MAX_DEPTH = 256;

/** Where inside the value a snapshot gave up, and what it found there, as
 * a predicate: `is a Date`, `is a Proxy`, `has a symbol key`. `at` is the
 * path from the snapshot's root (or from the root a path was read from).
 * `limit` is set only when the value is plain JSON nested past the limit:
 * then `at` is the root, because the path down to the level that crossed
 * the limit is as long as the limit and says nothing a reader can use. */
export interface Refusal {
  readonly at: readonly string[];
  readonly problem: string;
  readonly limit?: number;
}

export type Snapshot = { readonly value: unknown } | { readonly refused: Refusal };

/** What reading a path found: a snapshot, or nothing at segment `missing`
 * (an index into the path; the path's length when the value itself is
 * `undefined`). */
export type Read = Snapshot | { readonly missing: number };

const INDEX = /^(0|[1-9][0-9]*)$/;

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

/** What a value that is not plain JSON is, as a noun phrase. */
export function kindOf(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return String(value);
    return `the integer ${String(value)}, beyond Number.MAX_SAFE_INTEGER`;
  }
  if (typeof value === "bigint") return `the bigint ${String(value)}n`;
  if (typeof value === "function") return "a function";
  if (typeof value === "symbol") return "a symbol";
  if (typeof value === "object" && value !== null && types.isProxy(value)) return "a Proxy";
  const prototype = Object.getPrototypeOf(value) as { constructor?: unknown } | null;
  // The constructor is read by descriptor: a getter on the prototype is
  // code of the value's own.
  const constructor = prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  const name = typeof constructor === "function" ? Object.getOwnPropertyDescriptor(constructor, "name")?.value : undefined;
  return typeof name === "string" && name.length > 0 ? article(name) : "an object of no class";
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  // `target[key] = value` with the key `__proto__` sets the prototype
  // instead of adding a property, so JSON's own `__proto__` key would be
  // lost from the copy.
  if (key === "__proto__") Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  else target[key] = value;
}

/**
 * A fresh copy of `value` made of plain JSON, or the first part that is not.
 * Plain JSON is `null`, a boolean, a string, a finite number that is not an
 * integer beyond `Number.MAX_SAFE_INTEGER`, an array with no holes and no
 * other keys, or an object whose prototype is `Object.prototype` or `null`
 * and whose own properties are all enumerable data properties with string
 * keys, nested at most `maxDepth` containers deep. A Proxy is refused at any
 * depth, before anything is read through it. Pure.
 */
export function snapshot(value: unknown, maxDepth = SNAPSHOT_MAX_DEPTH): Snapshot {
  const ancestors = new Set<object>();
  let refusal: Refusal | null = null;
  const refuse = (at: readonly string[], problem: string, limit?: number): undefined => {
    refusal = limit === undefined ? { at, problem } : { at, problem, limit };
    return undefined;
  };
  const copy = (current: unknown, at: readonly string[]): unknown => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      return Number.isFinite(current) && (!Number.isInteger(current) || Number.isSafeInteger(current)) ? current : refuse(at, `is ${kindOf(current)}`);
    }
    if (typeof current !== "object") return refuse(at, `is ${kindOf(current)}`);
    if (types.isProxy(current)) return refuse(at, "is a Proxy");
    if (ancestors.has(current)) return refuse(at, "refers back to a value that holds it");
    if (at.length >= maxDepth) return refuse([], `nests deeper than ${maxDepth} levels`, maxDepth);
    const isArray = Array.isArray(current);
    const prototype: unknown = Object.getPrototypeOf(current);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      return refuse(at, `is ${kindOf(current)}`);
    }
    ancestors.add(current);
    const keys = Reflect.ownKeys(current);
    let result: unknown[] | Record<string, unknown>;
    if (isArray) {
      const items = current as unknown[];
      const out: unknown[] = new Array<unknown>(items.length);
      for (let index = 0; index < items.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(items, index);
        if (descriptor === undefined) return refuse([...at, String(index)], "is a hole");
        if (!("value" in descriptor)) return refuse([...at, String(index)], "is a getter");
        const item = copy(descriptor.value, [...at, String(index)]);
        if (refusal !== null) return undefined;
        out[index] = item;
      }
      for (const key of keys) {
        if (typeof key === "symbol") return refuse(at, "has a symbol key");
        if (key !== "length" && !INDEX.test(key)) return refuse(at, `has the key "${key}" beside its items`);
      }
      result = out;
    } else {
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        if (typeof key === "symbol") return refuse(at, "has a symbol key");
        const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
        if (!("value" in descriptor)) return refuse([...at, key], "is a getter");
        if (descriptor.enumerable !== true) return refuse([...at, key], "is not enumerable");
        const item = copy(descriptor.value, [...at, key]);
        if (refusal !== null) return undefined;
        setOwn(out, key, item);
      }
      result = out;
    }
    ancestors.delete(current);
    return result;
  };
  const result = copy(value, []);
  return refusal === null ? { value: result } : { refused: refusal };
}

/**
 * The snapshot of the value at `segments` inside `root`, walking own data
 * properties only, so no path reaches `Object.prototype` and no getter or
 * Proxy trap runs on the way. An array segment is a decimal index; nothing
 * else is read from an array, so `length` is not a path into one. A
 * refusal's `at` counts from `root`. Pure.
 */
export function readAt(root: unknown, segments: readonly string[], maxDepth = SNAPSHOT_MAX_DEPTH): Read {
  let current: unknown = root;
  for (let index = 0; index < segments.length; index += 1) {
    if (typeof current !== "object" || current === null) return { missing: index };
    if (types.isProxy(current)) return { refused: { at: segments.slice(0, index), problem: "is a Proxy" } };
    const segment = segments[index]!;
    if (Array.isArray(current) && !INDEX.test(segment)) return { missing: index };
    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    if (descriptor === undefined) return { missing: index };
    if (!("value" in descriptor)) return { refused: { at: segments.slice(0, index + 1), problem: "is a getter" } };
    current = descriptor.value;
  }
  if (current === undefined) return { missing: segments.length };
  const taken = snapshot(current, maxDepth);
  return "refused" in taken ? { refused: { ...taken.refused, at: [...segments, ...taken.refused.at] } } : taken;
}

/**
 * The snapshot of each key of a step's result, taken the moment the step
 * returned: what every later `from` value is a fresh copy of, so nothing
 * the producing step's code still holds reaches a later step or a claim.
 * A key whose value is `undefined` is absent, as in JSON; a key read
 * through a getter is refused without calling it. A result that is not an
 * object has no keys. Pure.
 */
export function snapshotKeys(result: unknown): ReadonlyMap<string, Snapshot> {
  const snapshots = new Map<string, Snapshot>();
  if (typeof result !== "object" || result === null || types.isProxy(result)) return snapshots;
  for (const key of Object.keys(result)) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key)!;
    if (!("value" in descriptor)) snapshots.set(key, { refused: { at: [], problem: "is a getter" } });
    else if (descriptor.value !== undefined) snapshots.set(key, snapshot(descriptor.value));
  }
  return snapshots;
}

/** A fresh copy of a value a snapshot already took, sharing no object with
 * it or with any other copy. */
export function copyOf(taken: { readonly value: unknown }): unknown {
  const again = snapshot(taken.value);
  // A snapshot's value is plain JSON within the depth limit, so taking one
  // of it again always succeeds.
  return "value" in again ? again.value : undefined;
}

/** A structured clone of one of `observe`'s inputs, or why none can be
 * made (a Proxy, a function, a class instance that holds one). `observe`
 * runs step code, so it receives copies only: nothing it does to an input
 * reaches an earlier step's result, another reading, or a value a claim
 * judges. The claims never read these copies (they read snapshots taken
 * before), so an input that is not plain JSON but clones (a Date, a Map) is
 * not refused here. */
export function inputCopy(value: unknown): { readonly value: unknown } | { readonly problem: string } {
  const found = uncloneable(value, [], new Set());
  if (found !== null) return { problem: found.at.length === 0 ? `is ${found.what}` : `holds ${found.what} at ${found.at.join(".")}` };
  try {
    return { value: structuredClone(value) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { problem: `is ${kindOf(value)}, which a structured clone cannot copy (${reason.split("\n")[0] ?? ""})` };
  }
}

/** The first part a structured clone refuses that a reader can name: a
 * Proxy (found before any trap runs), a function, or a symbol, walking own
 * data properties only. */
function uncloneable(value: unknown, at: readonly string[], seen: Set<object>): { readonly at: readonly string[]; readonly what: string } | null {
  if (typeof value === "function") return { at, what: "a function" };
  if (typeof value === "symbol") return { at, what: "a symbol" };
  if (typeof value !== "object" || value === null) return null;
  if (types.isProxy(value)) return { at, what: "a Proxy" };
  if (seen.has(value)) return null;
  seen.add(value);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) continue;
    const found = uncloneable(descriptor.value, [...at, key], seen);
    if (found !== null) return found;
  }
  return null;
}
