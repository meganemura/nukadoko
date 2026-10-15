import type { z } from "zod";
import { toStoredForm } from "./stored-form.js";

// Responsibility: turn a value read back from a record into the value a
// schema expects, where the stored form lost a type JSON cannot hold. A
// Date was stored as its ISO string and a bigint as its decimal string;
// each is revived only where the schema asks for that type and only when
// the string is exactly the stored form of one, so any other string still
// reaches the schema as a string and fails it there. tend checks a frozen
// result this way, and `nuka do` reads --args and --use values this way,
// so a contract that says z.bigint() is satisfied by what a record holds.

export type Parsed =
  | { success: true; data: unknown }
  | { success: false; error: { issues: readonly z.core.$ZodIssue[] } };

interface SchemaDef {
  type: string;
  shape?: Record<string, WalkableSchema>;
  element?: WalkableSchema;
  innerType?: WalkableSchema;
  options?: readonly WalkableSchema[];
  valueType?: WalkableSchema;
  items?: readonly WalkableSchema[];
  rest?: WalkableSchema | null;
  left?: WalkableSchema;
  right?: WalkableSchema;
  getter?: () => WalkableSchema;
  out?: WalkableSchema;
  catchall?: WalkableSchema;
}

export interface WalkableSchema {
  def: SchemaDef;
  safeParse(data: unknown): Parsed;
}

const UNWRAP = new Set(["optional", "nullable", "default", "prefault", "catch", "readonly", "nonoptional"]);

export function jsonForm(value: unknown): unknown {
  try {
    return toStoredForm(value);
  } catch {
    return undefined;
  }
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, (b as unknown[])[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    if (aKeys.length !== Object.keys(bObj).length) return false;
    return aKeys.every((key) => Object.prototype.hasOwnProperty.call(bObj, key) && jsonEqual(aObj[key], bObj[key]));
  }
  return false;
}

function reviveDate(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  // JSON.stringify writes Date.toJSON(), which is not every string new Date
  // can parse. Only that spelling is the JSON form of a Date.
  return date.toJSON() === value ? date : value;
}

function reviveBigint(value: unknown): unknown {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return value;
  const big = BigInt(value);
  return big.toString() === value ? big : value;
}

function reviveObject(def: SchemaDef, value: unknown, stack: Set<WalkableSchema>): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const shape = def.shape ?? {};
  const out: Record<string, unknown> = { ...source };
  for (const key of Object.keys(shape)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const child = shape[key];
    if (child !== undefined) out[key] = revive(child, source[key], stack);
  }
  const catchall = def.catchall;
  if (
    catchall !== undefined &&
    catchall.def.type !== "never" &&
    catchall.def.type !== "unknown" &&
    catchall.def.type !== "any"
  ) {
    for (const key of Object.keys(source)) {
      if (!Object.prototype.hasOwnProperty.call(shape, key)) out[key] = revive(catchall, source[key], stack);
    }
  }
  return out;
}

function reviveTuple(def: SchemaDef, value: unknown, stack: Set<WalkableSchema>): unknown {
  if (!Array.isArray(value) || def.items === undefined) return value;
  return value.map((item, index) => {
    const itemSchema = def.items?.[index] ?? def.rest;
    return itemSchema == null ? item : revive(itemSchema, item, stack);
  });
}

function reviveRecord(def: SchemaDef, value: unknown, stack: Set<WalkableSchema>): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value) || def.valueType === undefined) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = revive(def.valueType, item, stack);
  }
  return out;
}

function reviveUnion(def: SchemaDef, value: unknown, stack: Set<WalkableSchema>): unknown {
  for (const option of def.options ?? []) {
    const candidate = revive(option, value, stack);
    const outcome = option.safeParse(candidate);
    if (!outcome.success) continue;
    const form = jsonForm(outcome.data);
    if (form !== undefined && jsonEqual(form, value)) return candidate;
  }
  return value;
}

function revive(schema: WalkableSchema, value: unknown, stack: Set<WalkableSchema>): unknown {
  if (stack.has(schema)) return value;
  stack.add(schema);
  try {
    const def = schema.def;
    if (UNWRAP.has(def.type) && def.innerType !== undefined) {
      if (value === null || value === undefined) return value;
      return revive(def.innerType, value, stack);
    }
    switch (def.type) {
      case "date":
        return reviveDate(value);
      case "bigint":
        return reviveBigint(value);
      case "object":
        return reviveObject(def, value, stack);
      case "array":
        if (!Array.isArray(value) || def.element === undefined) return value;
        return value.map((item) => revive(def.element as WalkableSchema, item, stack));
      case "tuple":
        return reviveTuple(def, value, stack);
      case "record":
        return reviveRecord(def, value, stack);
      case "union":
        return reviveUnion(def, value, stack);
      case "intersection":
        if (def.left === undefined || def.right === undefined) return value;
        return revive(def.right, revive(def.left, value, stack), stack);
      case "lazy":
        return def.getter === undefined ? value : revive(def.getter(), value, stack);
      case "pipe":
        return def.out === undefined ? value : revive(def.out, value, stack);
      default:
        return value;
    }
  } finally {
    stack.delete(schema);
  }
}

/** `value` with every Date and bigint the schema expects revived from its
 * stored string. Anything else is returned as it is. */
export function reviveStoredForm(schema: { safeParse(data: unknown): unknown }, value: unknown): unknown {
  return revive(schema as WalkableSchema, value, new Set());
}
