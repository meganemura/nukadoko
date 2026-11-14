import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { z } from "zod";
import { returnsDropped } from "../src/step/returns-dropped.js";

// Responsibility: `returnsDropped`, the measurement behind a step record's
// `returns_dropped` (docs/spec.md "Records"): which keys a step's
// `returns` dropped from the value its code returned, and where nukadoko
// could not see. The record itself is covered end to end in
// tests/claim-steps-run.test.ts.

describe("what a step's returns dropped from the value its code returned", () => {
  // Weighted toward a z.object, the one schema that drops a key.
  const CONTAINERS = ["object", "object", "object", "strictObject", "looseObject", "array", "array", "record", "renamingRecord", "passOn", "transform", "union"] as const;
  const OBJECT_WRAPPERS = ["optional", "nullable", "readonly", "default", "catch", "prefault"] as const;

  /** A returns schema of nested objects, arrays, records, unions, and
   * pipes, with a value the step's code could return for it: most declared
   * keys, a key no object declares (x or y, mostly a number, sometimes
   * undefined), and the value a wrapper takes in place of the object.
   * `seen` is false when the schema holds a transform or a record whose
   * key schema renames a key, where `returns` can parse a value the step
   * did not return at that place. */
  const returnsCases = gs.composite((tc) => {
    let seen = true;
    const often = (): boolean => tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) > 0;
    const leaf = { schema: z.number().optional() as z.ZodTypeAny, value: (): unknown => (often() ? 1 : undefined) };
    const build = (depth: number): { schema: z.ZodTypeAny; value: () => unknown } => {
      if (depth === 3 || (depth > 0 && !often())) return leaf;
      const kind = depth === 0 ? "object" : tc.draw(gs.sampledFrom(CONTAINERS));
      if (kind === "array") {
        const item = build(depth + 1);
        return { schema: z.array(item.schema), value: () => Array.from({ length: tc.draw(gs.integers({ minValue: 0, maxValue: 2 })) }, item.value) };
      }
      if (kind === "record" || kind === "renamingRecord") {
        const item = build(depth + 1);
        if (kind === "renamingRecord") seen = false;
        const keyType = kind === "record" ? z.string() : z.string().toLowerCase();
        return {
          schema: z.record(keyType, item.schema),
          value: () => Object.fromEntries(tc.draw(gs.arrays(gs.sampledFrom(["a", "b", "B"]), { maxSize: 2, unique: true })).map((key) => [key, item.value()])),
        };
      }
      if (kind === "passOn" || kind === "transform") {
        const inner = build(depth + 1);
        if (kind === "transform") seen = false;
        return { schema: kind === "passOn" ? z.unknown().pipe(inner.schema) : z.unknown().transform((value) => value).pipe(inner.schema), value: inner.value };
      }
      if (kind === "union") {
        const inner = build(depth + 1);
        return { schema: z.union([inner.schema, z.string()]), value: () => (often() ? inner.value() : "s") };
      }
      const keys = [...new Set(tc.draw(gs.arrays(gs.sampledFrom(["a", "b", "c"]), { minSize: 1, maxSize: 3 })))];
      const children = Object.fromEntries(keys.map((key) => [key, build(depth + 1)]));
      const shape = Object.fromEntries(keys.map((key) => [key, children[key]!.schema]));
      let schema: z.ZodTypeAny = kind === "object" ? z.object(shape) : kind === "strictObject" ? z.strictObject(shape) : z.looseObject(shape);
      let made = (): unknown => {
        const value: Record<string, unknown> = {};
        for (const key of keys) if (often()) value[key] = children[key]!.value();
        for (const key of tc.draw(gs.arrays(gs.sampledFrom(["x", "y"]), { maxSize: 2, unique: true }))) value[key] = often() ? 1 : undefined;
        return value;
      };
      if (depth > 0 && !often()) {
        const wrapper = tc.draw(gs.sampledFrom(OBJECT_WRAPPERS));
        const inner = schema as z.ZodObject;
        const object = made;
        schema =
          wrapper === "optional"
            ? inner.optional()
            : wrapper === "nullable"
              ? inner.nullable()
              : wrapper === "readonly"
                ? inner.readonly()
                : wrapper === "default"
                  ? inner.default({ zz: 1 } as never)
                  : wrapper === "catch"
                    ? inner.catch({ zz: 1 } as never)
                    : inner.prefault({ zz: 1 } as never);
        const instead = wrapper === "nullable" ? null : wrapper === "catch" ? "wrong" : undefined;
        made = () => (wrapper === "readonly" || often() ? object() : instead);
      }
      return { schema, value: made };
    };
    const root = build(0);
    return { schema: root.schema, returned: root.value(), seen: () => seen };
  });

  /** Every object and array in a parsed value, with its path. */
  const containers = (value: unknown, at: readonly string[] = []): (readonly [readonly string[], unknown])[] => {
    if (typeof value !== "object" || value === null) return [];
    const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
    return [[at, value], ...entries.flatMap(([key, item]) => containers(item, [...at, key]))];
  };
  const valueAt = (root: unknown, at: readonly string[]): unknown =>
    at.reduce<unknown>((value, key) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined), root);
  const covers = (outer: readonly string[], inner: readonly string[]): boolean => outer.length <= inner.length && outer.every((key, index) => inner[index] === key);
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && covers(a, b);

  it("names, at each object of the parsed value, the keys the step returned there with a value that the object lacks, once, and nothing anywhere else", () =>
    hegel.testAsync(
      async (tc) => {
        const { schema, returned } = tc.draw(returnsCases);
        const parsed = schema.safeParse(returned);
        tc.assume(parsed.success);
        const found = returnsDropped(schema, structuredClone(returned), parsed.data);
        const objects = containers(parsed.data).filter(([, value]) => !Array.isArray(value));
        for (const entry of found) expect(objects.some(([at]) => covers(entry.at, at))).toBe(true);
        for (const [index, entry] of found.entries()) {
          for (const other of found.slice(index + 1)) expect(same(other.at, entry.at)).toBe(false);
          if ("unmeasured" in entry) for (const other of found) if (other !== entry) expect(covers(entry.at, other.at)).toBe(false);
        }
        for (const [at, value] of objects) {
          if (found.some((entry) => "unmeasured" in entry && covers(entry.at, at))) continue;
          const named = found.find((entry) => "keys" in entry && same(entry.at, at)) as { keys: readonly string[] } | undefined;
          const raw = valueAt(returned, at);
          const dropped =
            typeof raw === "object" && raw !== null && !Array.isArray(raw)
              ? Object.keys(raw).filter((key) => (raw as Record<string, unknown>)[key] !== undefined && !Object.hasOwn(value as object, key))
              : [];
          expect(named?.keys ?? []).toEqual(dropped);
        }
      },
      { testCases: 300 },
    ));

  it("says it could not see which keys only where returns parsed a value the step did not return at that place", () =>
    hegel.testAsync(
      async (tc) => {
        const drawn = tc.draw(returnsCases);
        const parsed = drawn.schema.safeParse(drawn.returned);
        tc.assume(parsed.success && drawn.seen());
        expect(returnsDropped(drawn.schema, drawn.returned, parsed.data).filter((entry) => "unmeasured" in entry)).toEqual([]);
      },
      { testCases: 300 },
    ));

  it("runs no code of the value the step returned, and says where it stopped seeing it", () => {
    // Two objects below the getter, which nukadoko names once.
    const user = z.object({ name: z.string(), profile: z.object({ bio: z.object({ text: z.string() }) }).optional() });
    const schema = z.object({ user });
    const measured = (returned: unknown) => returnsDropped(schema, returned, schema.parse(returned));
    let calls = 0;
    const withGetter = { name: "aki" };
    Object.defineProperty(withGetter, "profile", { enumerable: true, get: () => ((calls += 1), { bio: { text: "b" }, tag: 1 }) });
    const parsedOnce = schema.parse({ user: withGetter });
    calls = 0;
    expect(returnsDropped(schema, { user: withGetter }, parsedOnce)).toEqual([{ at: ["user", "profile"], unmeasured: "the step returned a getter at user.profile, which nukadoko does not call" }]);
    expect(calls).toBe(0);
    class Account {
      readonly token = "t";
      get name() {
        return "aki";
      }
    }
    expect(measured({ user: new Account() })).toEqual([{ at: ["user"], keys: ["token"] }]);
    class Member {
      readonly name = "aki";
      get profile() {
        return { bio: { text: "b" }, tag: 1 };
      }
    }
    expect(measured({ user: new Member() })).toEqual([
      { at: ["user", "profile"], unmeasured: "the step returned a Member at user, whose profile comes from its prototype, which nukadoko does not read" },
    ]);
    const trapped = new Proxy({ name: "aki", password: "p" }, {});
    expect(measured({ user: trapped })).toEqual([{ at: ["user"], unmeasured: "the step returned a Proxy at user, which nukadoko does not read" }]);
    expect(measured({ user: { name: "aki", password: "p", gone: undefined }, debug: true })).toEqual([
      { at: [], keys: ["debug"] },
      { at: ["user"], keys: ["password"] },
    ]);
    expect(measured({ user: { name: "aki" } })).toEqual([]);
  });

  it("names what a union, an intersection, and a pipe that hands the value on dropped, and stops at a transform", () => {
    const user = z.object({ name: z.string() });
    const returned = { user: { name: "aki", password: "p" } };
    for (const wrapped of [z.union([user, z.string()]), z.intersection(user, z.object({})), z.unknown().pipe(user), z.lazy(() => user)]) {
      const schema = z.object({ user: wrapped });
      expect(returnsDropped(schema, returned, schema.parse(returned))).toEqual([{ at: ["user"], keys: ["password"] }]);
    }
    const union = z.object({ user: z.union([user, z.string()]) });
    const trapped = { user: new Proxy({ name: "aki", password: "p" }, {}) };
    expect(returnsDropped(union, trapped, union.parse(trapped))).toEqual([{ at: ["user"], unmeasured: "the step returned a Proxy at user, which nukadoko does not read" }]);
    const text = z.object({ user: z.string().transform((body) => JSON.parse(body) as unknown).pipe(user) });
    const body = { user: '{"name":"aki","password":"p"}' };
    expect(returnsDropped(text, body, text.parse(body))).toEqual([
      { at: ["user"], unmeasured: "returns parsed user through a pipe or a transform, whose value nukadoko cannot match with the one the step returned" },
    ]);
    const either = z.object({ user: z.union([user, z.object({ id: z.string().transform(Number) })]) });
    expect(returnsDropped(either, returned, either.parse(returned))).toEqual([
      {
        at: ["user"],
        unmeasured: "returns parsed user through a union that holds a pipe, a transform, or a record whose key schema can change a key, so nukadoko cannot tell which part parsed it",
      },
    ]);
    // The step's user fails the strict object, so the catch stands in for
    // it, and password is a key the step returned that result lacks there.
    const caught = z.object({ user: z.union([z.strictObject({ name: z.string() }).catch({ name: "kei" }), z.string()]) });
    expect(returnsDropped(caught, returned, caught.parse(returned))).toEqual([{ at: ["user"], keys: ["password"] }]);
    // A transform whose value no schema in it can drop a key from.
    const counted = z.object({ user: z.unknown().transform(() => ({ count: 1 })) });
    expect(returnsDropped(counted, returned, counted.parse(returned))).toEqual([]);
  });

  it("names nothing where a default, a prefault, or a catch stands in for an object the step did not return", () => {
    const user = z.object({ name: z.string() });
    for (const filled of [user.default({ name: "kei", password: "p" } as never), user.prefault({ name: "kei", password: "p" } as never), user.catch({ name: "kei" })]) {
      const schema = z.object({ user: filled });
      expect(returnsDropped(schema, {}, schema.parse({}))).toEqual([]);
      expect(returnsDropped(schema, { user: { name: "aki", password: "p" } }, schema.parse({ user: { name: "aki", password: "p" } }))).toEqual([{ at: ["user"], keys: ["password"] }]);
    }
    // zod hands the default back without the pipe below it.
    const text = z.object({ user: z.string().transform((body) => JSON.parse(body) as unknown).pipe(user).default({ name: "kei" }) });
    expect(returnsDropped(text, {}, text.parse({}))).toEqual([]);
  });

  it("counts the keys a catch's own value lacks, wherever the catch sits, since the catch may have stood in for the step's value", () => {
    const returned = { user: { password: "p" } };
    const strict = z.object({ user: z.union([z.strictObject({ name: z.string() }), z.string()]).catch({ name: "kei" }) });
    expect(returnsDropped(strict, returned, strict.parse(returned))).toEqual([{ at: ["user"], keys: ["password"] }]);
    const loose = z.object({ user: z.looseObject({ name: z.string() }).catch({ name: "kei" }) });
    const trapped = { user: new Proxy({ password: "p" }, {}) };
    expect(returnsDropped(loose, trapped, loose.parse(trapped))).toEqual([{ at: ["user"], unmeasured: "the step returned a Proxy at user, which nukadoko does not read" }]);
    const piped = z.object({ user: z.unknown().transform((value) => value).pipe(z.looseObject({ name: z.string() })).catch({ name: "kei" }) });
    expect(returnsDropped(piped, returned, piped.parse(returned))).toEqual([
      { at: ["user"], unmeasured: "returns parsed user through a pipe or a transform, whose value nukadoko cannot match with the one the step returned" },
    ]);
  });

  it("reads each item of a record whose key schema keeps a key, and stops where the key schema can change one", () => {
    const item = z.object({ name: z.string() });
    const returned = { a: { name: "mio" }, b: { name: "aki", password: "p" }, B: { name: "kei" } };
    const kept = z.object({ people: z.record(z.string(), item) });
    expect(returnsDropped(kept, { people: returned }, kept.parse({ people: returned }))).toEqual([{ at: ["people", "b"], keys: ["password"] }]);
    // toLowerCase makes "B" and "b" one key, so the parsed item at "b" may
    // be the one the step returned at "B", and its keys say nothing.
    const renamed = z.object({ people: z.record(z.string().toLowerCase(), item) });
    expect(returnsDropped(renamed, { people: returned }, renamed.parse({ people: returned }))).toEqual([
      { at: ["people"], unmeasured: "returns parsed people through a record whose key schema can change a key" },
    ]);
  });
});
