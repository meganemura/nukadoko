import { types } from "node:util";
import type { z } from "zod";
import type { ReturnsDrop } from "../record/types.js";
import { kindOf, SNAPSHOT_MAX_DEPTH } from "./snapshot.js";

// Responsibility: measure which keys a typed step's `returns` dropped from
// the value the step's code returned, for the step record's
// `returns_dropped` (docs/spec.md "Records"). A `z.object` drops every key
// it does not declare, and so does a union or an intersection of one, so a
// key the step returned can be missing from `result` with nothing in
// `result` to say so. The walk follows the parsed value and reads the
// returned one at the same path, and the schema says only where those two
// are not one value at one place: a pipe or a transform, and a record
// whose key schema can change a key. Does not parse, run the step, or run
// any code of the returned value: it calls no getter and reads nothing
// through a Proxy, and names such a place as one it could not see into.

interface ZodDef {
  readonly type: string;
  readonly innerType?: z.ZodTypeAny;
  readonly in?: z.ZodTypeAny;
  readonly out?: z.ZodTypeAny;
  readonly getter?: () => z.ZodTypeAny;
  readonly shape?: Record<string, z.ZodTypeAny>;
  readonly catchall?: z.ZodTypeAny;
  readonly keyType?: z.ZodTypeAny;
  readonly valueType?: z.ZodTypeAny;
  readonly element?: z.ZodTypeAny;
  readonly items?: readonly z.ZodTypeAny[];
  readonly rest?: z.ZodTypeAny | null;
  readonly options?: readonly z.ZodTypeAny[];
  readonly left?: z.ZodTypeAny;
  readonly right?: z.ZodTypeAny;
  readonly checks?: readonly { readonly _zod: { readonly def: { readonly check: string } } }[];
}

function defOf(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { def: ZodDef }).def;
}

// The schemas that parse the value at their own place and hand on what
// their inner schema made of it. `catch` is here too: when it gives its
// own value instead, the keys the step returned that the value lacks are
// still keys `result` lacks there.
const SAME_PLACE: ReadonlySet<string> = new Set(["optional", "nullable", "nonoptional", "readonly", "catch"]);
// zod hands back a default as it was given, and parses a prefault in place
// of an undefined value: where the step returned nothing, neither holds a
// key the step returned.
const IN_PLACE_OF_NOTHING: ReadonlySet<string> = new Set(["default", "prefault"]);
// A pipe whose first schema is one of these hands the value on unchanged.
const PASSES_ON: ReadonlySet<string> = new Set(["unknown", "any"]);
const KEPT_RECORD_KEYS: ReadonlySet<string> = new Set(["string", "enum", "literal", "template_literal"]);
// A lazy schema whose getter returns another lazy schema, without end.
const MAX_UNWRAPS = 64;

/** Whether a record's key schema hands back every key as it was given: a
 * transform, a catch, or an overwrite such as `toLowerCase` can put a
 * value under a key the step did not return it under. */
function keepsRecordKeys(keyType: z.ZodTypeAny | undefined): boolean {
  if (keyType === undefined) return false;
  const def = defOf(keyType);
  return KEPT_RECORD_KEYS.has(def.type) && !(def.checks ?? []).some((check) => check._zod.def.check === "overwrite");
}

/** The schemas directly inside `schema` that parse some part of its value. */
function partsOf(def: ZodDef): readonly z.ZodTypeAny[] {
  const parts: (z.ZodTypeAny | null | undefined)[] = [def.innerType, def.in, def.out, def.catchall, def.valueType, def.element, def.rest, def.left, def.right];
  parts.push(...Object.values(def.shape ?? {}), ...(def.items ?? []), ...(def.options ?? []));
  if (def.type === "lazy" && def.getter !== undefined) parts.push(def.getter());
  return parts.filter((part): part is z.ZodTypeAny => part !== undefined && part !== null);
}

/** Whether some schema in `schema`, itself included, matches `test`. A
 * lazy schema that holds itself is read once. */
function holds(schema: z.ZodTypeAny, test: (def: ZodDef) => boolean, seen: Set<z.ZodTypeAny> = new Set()): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  const def = defOf(schema);
  return test(def) || partsOf(def).some((part) => holds(part, test, seen));
}

/** A `z.object` with no catchall, which drops a key it does not declare,
 * a catch, whose own value can stand in for the step's, or a record that
 * can move a value to another key. */
const losesKeys = (def: ZodDef): boolean =>
  (def.type === "object" && def.catchall === undefined) || def.type === "catch" || (def.type === "record" && !keepsRecordKeys(def.keyType));

/** A pipe that can hand on a value of its own, or a record that can move
 * a value to another key: below one, a value is not at the path it was
 * returned at. */
const movesValues = (def: ZodDef): boolean =>
  (def.type === "pipe" && (def.in === undefined || !PASSES_ON.has(defOf(def.in).type))) || (def.type === "record" && !keepsRecordKeys(def.keyType));

/** What the walk read of the returned value at one place: the value, or
 * the place where it stopped seeing it, and why. */
type ReturnedRead = { readonly value: unknown } | { readonly unseen: readonly string[]; readonly why: string };

function placeOf(at: readonly string[]): string {
  return at.length === 0 ? "the result" : at.join(".");
}

/** The value at `key` of `read`, the way `returns` read it, but without
 * running any code of the value's own. */
function returnedAt(read: ReturnedRead, key: string, at: readonly string[]): ReturnedRead {
  if ("unseen" in read) return read;
  const value = read.value;
  if (typeof value !== "object" || value === null) return { value: undefined };
  if (types.isProxy(value)) return { unseen: at, why: `the step returned a Proxy at ${placeOf(at)}, which nukadoko does not read` };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    const prototype: unknown = Object.getPrototypeOf(value);
    // zod reads a key the value does not hold through its prototype,
    // which for a class instance can be a getter.
    if (prototype === null || prototype === Object.prototype || prototype === Array.prototype) return { value: undefined };
    return { unseen: [...at, key], why: `the step returned ${kindOf(value)} at ${placeOf(at)}, whose ${key} comes from its prototype, which nukadoko does not read` };
  }
  if (!("value" in descriptor)) return { unseen: [...at, key], why: `the step returned a getter at ${placeOf([...at, key])}, which nukadoko does not call` };
  return { value: descriptor.value };
}

/**
 * Each place in a step's result where its `returns` dropped keys the
 * step's code returned (`{ at, keys }`), or where nukadoko cannot see
 * which (`{ at, unmeasured }`). `returned` is what the step's code
 * returned and `parsed` what its `returns` made of it.
 *
 * A key is dropped at a place when the returned value holds it there, with
 * a value other than `undefined` (no copy of the value holds that), and
 * the parsed value holds an object there without it. The walk stops seeing
 * the returned value at a getter, a Proxy, a key read through a prototype,
 * a pipe or a transform (unless its first schema is `z.unknown()` or
 * `z.any()`), a record whose key schema can change a key, a union or an
 * intersection that holds one of the last two, and a value nested deeper
 * than a snapshot keeps. Such a place is `unmeasured` once, at the
 * outermost place, and only when a schema at or inside it can lose a key:
 * a `z.object`, a catch, or a record whose key schema can change a key.
 * Inside any other union or intersection, the walk reads the two values
 * alone, since nukadoko does not know which part parsed the value there,
 * and the object that part made holds the keys of the one returned. Never
 * throws. Pure.
 */
export function returnsDropped(schema: z.ZodTypeAny, returned: unknown, parsed: unknown): ReturnsDrop[] {
  const found: ReturnsDrop[] = [];
  const reported = new Set<string>();
  const unmeasured = (read: ReturnedRead, at: readonly string[], why: string): void => {
    const place = "unseen" in read ? read.unseen : at;
    const key = JSON.stringify(place);
    if (reported.has(key)) return;
    reported.add(key);
    found.push({ at: place, unmeasured: "unseen" in read ? read.why : why });
  };
  // `schema` is `null` inside a union or an intersection the walk reads
  // without its schema; `lossy` then says whether it can drop a key.
  const visit = (schema: z.ZodTypeAny | null, lossy: boolean, value: unknown, read: ReturnedRead, at: readonly string[]): void => {
    // A parsed container is one zod built, and a Proxy only reaches here
    // through a schema that passes a value on unparsed, which drops no key.
    if (typeof value !== "object" || value === null || types.isProxy(value)) return;
    if (at.length > SNAPSHOT_MAX_DEPTH) {
      unmeasured(read, at, `${placeOf(at)} nests deeper than ${SNAPSHOT_MAX_DEPTH} levels, and nukadoko reads no deeper`);
      return;
    }
    let current = schema;
    let def: ZodDef | null = null;
    // A catch at this place can stand in for what the step returned here.
    let caught = false;
    for (let unwraps = 0; current !== null; unwraps += 1) {
      if (unwraps > MAX_UNWRAPS) return;
      def = defOf(current);
      if (IN_PLACE_OF_NOTHING.has(def.type) && !("unseen" in read) && read.value === undefined) return;
      if ((SAME_PLACE.has(def.type) || IN_PLACE_OF_NOTHING.has(def.type)) && def.innerType !== undefined) {
        caught ||= def.type === "catch";
        current = def.innerType;
      }
      else if (def.type === "lazy" && def.getter !== undefined) current = def.getter();
      else if (def.type === "pipe" && def.in !== undefined && def.out !== undefined && PASSES_ON.has(defOf(def.in).type)) current = def.out;
      else if (def.type === "pipe") {
        if (caught || holds(current, losesKeys)) unmeasured(read, at, `returns parsed ${placeOf(at)} through a pipe or a transform, whose value nukadoko cannot match with the one the step returned`);
        return;
      } else if (def.type === "union" || def.type === "intersection") {
        if (!caught && !holds(current, losesKeys)) return;
        if (holds(current, movesValues)) {
          const what = def.type === "union" ? "a union" : "an intersection";
          unmeasured(read, at, `returns parsed ${placeOf(at)} through ${what} that holds a pipe, a transform, or a record whose key schema can change a key, so nukadoko cannot tell which part parsed it`);
          return;
        }
        current = null;
        def = null;
        lossy = true;
      } else break;
    }
    if (def !== null && def.type === "record" && !keepsRecordKeys(def.keyType)) {
      unmeasured(read, at, `returns parsed ${placeOf(at)} through a record whose key schema can change a key`);
      return;
    }
    const object = def === null || def.type === "object" || def.type === "record";
    let inside = read;
    if (object && !Array.isArray(value)) {
      if (!("unseen" in read)) {
        const returnedHere = read.value;
        // A catch or a default stands in for what the step returned here,
        // which holds no key.
        if (typeof returnedHere !== "object" || returnedHere === null) return;
        if (types.isProxy(returnedHere)) inside = { unseen: at, why: `the step returned a Proxy at ${placeOf(at)}, which nukadoko does not read` };
        else {
          const keys = Object.keys(returnedHere).filter((key) => {
            if (Object.hasOwn(value, key)) return false;
            const descriptor = Object.getOwnPropertyDescriptor(returnedHere, key);
            return descriptor !== undefined && (!("value" in descriptor) || descriptor.value !== undefined);
          });
          if (keys.length > 0) found.push({ at, keys });
        }
      }
      const drops = caught || (def === null ? lossy : losesKeys(def));
      if ("unseen" in inside && drops) unmeasured(inside, at, inside.why);
    }
    const parsedAt = (key: string): unknown => (value as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      if (def !== null && def.type !== "array" && def.type !== "tuple") return;
      for (let index = 0; index < value.length; index += 1) {
        const item = def === null ? null : def.type === "array" ? def.element : (def.items?.[index] ?? def.rest ?? undefined);
        if (item !== undefined) visit(item, lossy, value[index], returnedAt(inside, String(index), at), [...at, String(index)]);
      }
      return;
    }
    if (!object) return;
    for (const key of Object.keys(value)) {
      const part = def === null ? null : def.type === "record" ? def.valueType : (def.shape?.[key] ?? def.catchall);
      if (part !== undefined) visit(part, lossy, parsedAt(key), returnedAt(inside, key, at), [...at, key]);
    }
  };
  try {
    visit(schema, false, parsed, { value: returned }, []);
  } catch (error) {
    // Reading an exotic object's own keys can throw (a module namespace
    // whose binding is not set yet), and so can a lazy schema's getter,
    // and the step itself succeeded.
    return [{ at: [], unmeasured: `nukadoko could not read the value the step returned: ${error instanceof Error ? error.message : String(error)}` }];
  }
  return found;
}
