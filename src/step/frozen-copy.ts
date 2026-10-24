import { types } from "node:util";

// Responsibility: the one copy of a step definition's data that defineStep
// validates and the run reads (docs/spec.md "Claims", "The shape").
// `frozenCopy` walks a value once and returns a new copy in which every
// array and plain object is frozen, or the path to the first part it
// refuses: a getter or a setter, a Proxy, or an object of a class. A
// function and a value `keep` names (a step) are kept by reference, since
// they are code and not data. Pure; it runs no code of the value's own.
//
// Why a copy and not the object a step file passed: freezing that object
// in place stops at an object the step file froze itself, and leaves
// every object inside it writable, so a claim could change after it was
// validated. A getter could answer validation one way and the run another,
// and a step file could keep a reference and change it after defineStep
// returned. A copy that nothing else holds has none of these. The module
// does not validate a claim (claims.ts does) and does not know which
// fields a definition has (define-step.ts does).

/** Where the copy gave up and why: `path` as the step file writes it
 * (`claims[0].each.where[1].compare`), `problem` a predicate. */
export interface CopyRefusal {
  readonly path: string;
  readonly problem: string;
}

export type FrozenCopy<T> = { readonly value: T } | { readonly refused: CopyRefusal };

function pathOf(parent: string, key: string, inArray: boolean): string {
  if (inArray) return `${parent}[${key}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function className(value: object): string {
  const prototype = Object.getPrototypeOf(value) as object | null;
  const constructor = prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  const name = typeof constructor === "function" ? Object.getOwnPropertyDescriptor(constructor, "name")?.value : undefined;
  return typeof name === "string" && name.length > 0 ? name : "an unnamed class";
}

/**
 * A new copy of `value` with every array and plain object in it frozen, at
 * every level, or the first part that cannot be copied that way. Strings,
 * numbers, booleans, `null`, `undefined`, bigints, and symbols are values;
 * a function and any object `keep` accepts are kept as they are. An array
 * keeps its items and no other keys; a plain object (prototype
 * `Object.prototype` or `null`, kept on the copy) keeps its own enumerable
 * string keys. A Proxy, a getter or a setter, a value that holds itself,
 * and any other object are refused, named by `path`. Pure.
 */
export function frozenCopy<T>(value: T, path: string, keep: (value: object) => boolean = () => false): FrozenCopy<T> {
  const ancestors = new Set<object>();
  let refusal: CopyRefusal | null = null;
  const refuse = (at: string, problem: string): undefined => {
    refusal = { path: at, problem };
    return undefined;
  };
  const copy = (current: unknown, at: string): unknown => {
    if (typeof current === "function") return current;
    if (typeof current !== "object" || current === null) return current;
    if (types.isProxy(current)) return refuse(at, "is a Proxy");
    if (keep(current)) return current;
    if (ancestors.has(current)) return refuse(at, "holds itself");
    const isArray = Array.isArray(current);
    const prototype: unknown = Object.getPrototypeOf(current);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      return refuse(at, `is an object of the class ${className(current)}, not plain data`);
    }
    ancestors.add(current);
    // A dictionary made with `Object.create(null)` stays one, so a key
    // the step file never wrote (`constructor`) is not found on the copy.
    const out: unknown[] | Record<string, unknown> = isArray ? [] : (Object.create(prototype as object | null) as Record<string, unknown>);
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key === "symbol") continue;
      if (isArray && !/^(0|[1-9][0-9]*)$/.test(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
      const keyPath = pathOf(at, key, isArray);
      if (!("value" in descriptor)) return refuse(keyPath, "is a getter or a setter");
      if (descriptor.enumerable !== true) continue;
      const item = copy(descriptor.value, keyPath);
      if (refusal !== null) return undefined;
      // defineProperty, so an own `__proto__` key stays a key.
      Object.defineProperty(out, key, { value: item, enumerable: true, writable: true, configurable: true });
    }
    ancestors.delete(current);
    return Object.freeze(out);
  };
  const result = copy(value, path);
  return refusal === null ? { value: result as T } : { refused: refusal };
}

/**
 * Freezes every array and plain object inside `value`, at every level,
 * including below an object that was frozen already; a function and an
 * object `keep` accepts are left alone. For a value `frozenCopy` copied:
 * the run reads the copy, and freezing the step file's own objects too
 * makes a later write to them throw where the step file makes it, instead
 * of changing an object nothing reads.
 */
export function freezeInPlace(value: unknown, keep: (value: object) => boolean = () => false): void {
  const seen = new Set<object>();
  const visit = (current: unknown): void => {
    if (typeof current !== "object" || current === null || types.isProxy(current) || keep(current) || seen.has(current)) return;
    seen.add(current);
    for (const key of Object.keys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined && "value" in descriptor) visit(descriptor.value);
    }
    Object.freeze(current);
  };
  visit(value);
}
