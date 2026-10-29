import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Generator } from "@hegeldev/hegel/generators";
import { z } from "zod";
import type { ClaimCompare, ClaimComparisonRecord, ClaimEachRecord, ReturnsDrop } from "../src/record/types.js";
import { droppedKeysAt, type FilledFrom } from "../src/run/execute-typed-step.js";
import type { Claim, ItemClaim } from "../src/step/claims.js";
import type { Step } from "../src/step/define-step.js";
import { evaluateClaims, judgingBudget, readerNow, type ClaimInputs, type DroppedKeys, type PatternTester } from "../src/step/evaluate-claims.js";
import { readReturnsDropped } from "../src/step/resolve-use.js";
import { brokenClaimsMessage, claimLine } from "../src/report/summary/claim-line.js";

// Responsibility: how a claim is judged on a `from` value whose
// producer's `returns` dropped keys (docs/spec.md "The value a claim
// judges"), as properties over a drawn value as a step returned it, the
// keys a parse dropped from it, and what the producer's record says of
// them: a claim that holds on the parsed copy holds on the value as
// returned, a claim comes out otherwise than on the copy alone only as
// `unjudged` with a reason that names the drop, nothing changes where
// nothing was dropped, and a claim left unjudged could have broken on
// some value the step could have returned. The walk that measures the
// drops is tests/returns-dropped.test.ts's job, and a run that carries
// them is tests/claim-steps-run.test.ts's.

const leaf: Generator<unknown> = gs.oneOf<unknown>(gs.just(null), gs.booleans(), gs.integers({ minValue: 0, maxValue: 3 }), gs.text({ alphabet: "ab", maxSize: 2 }));

function jsonValue(depth: number): Generator<unknown> {
  if (depth === 0) return leaf;
  const child = jsonValue(depth - 1);
  return gs.oneOf<unknown>(
    leaf,
    gs.arrays(child, { maxSize: 3 }),
    gs.composite((tc) => {
      const count = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
      const object: Record<string, unknown> = {};
      for (let index = 0; index < count; index += 1) object[tc.draw(gs.text({ alphabet: "ab", minSize: 1, maxSize: 2 }))] = tc.draw(child);
      return object;
    }),
  );
}

/** An object or an array more often than a leaf, since only an object
 * can have a key dropped. */
const container = (depth: number): Generator<unknown> =>
  gs.oneOf<unknown>(
    gs.arrays(jsonValue(depth - 1), { minSize: 1, maxSize: 3 }),
    gs.composite((tc) => {
      const count = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
      const object: Record<string, unknown> = {};
      for (let index = 0; index < count; index += 1) object[tc.draw(gs.text({ alphabet: "ab", minSize: 1, maxSize: 2 }))] = tc.draw(jsonValue(depth - 1));
      return object;
    }),
  );

/** An array whose items are mostly copies of one value, so a claim on
 * every item can hold. */
const alikeItems: Generator<unknown[]> = gs.composite((tc) => {
  const base = tc.draw(container(2));
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
  return Array.from({ length: count }, () => (tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) > 0 ? structuredClone(base) : tc.draw(container(2))));
});

/** A key no drawn value holds, for a schema that declares more than the
 * step returned. */
const UNRETURNED_KEY = "zz";

/** A value as a step returned it, the copy its `returns` parsed, and what
 * the producer's record says was dropped: its `returns_dropped`
 * (`measured`), or, for a record without the field, the keys each
 * object schema that drops a key declares (`declared`, by place). */
interface Produced {
  readonly raw: unknown;
  readonly parsed: unknown;
  readonly measured: ReturnsDrop[] | undefined;
  readonly declared: ReadonlyMap<string, readonly string[]>;
}

const placeKey = (at: readonly string[]): string => at.join("\u0000");

interface ProduceOptions {
  readonly unseen: boolean;
  readonly unrecorded: boolean;
  /** `false` for a producer that drops nothing. */
  readonly drops?: boolean;
  /** The step returned `value` with more keys, which its `returns`
   * dropped, so the parsed copy is `value` itself. */
  readonly widen?: boolean;
}

/** Each object of `value` is parsed by a schema that keeps every key, or
 * by one that drops the keys it does not declare: some of the keys
 * `value` holds, or, under `widen`, keys the step returned beside
 * them. `unseen` draws places the record names as unmeasured, and
 * `unrecorded` a record without the field. */
function produce(tc: hegel.TestCase, value: unknown, options: ProduceOptions): Produced {
  const measured: ReturnsDrop[] = [];
  const declared = new Map<string, readonly string[]>();
  const places: string[][] = [];
  const walk = (value: unknown, at: string[]): { raw: unknown; parsed: unknown } => {
    if (Array.isArray(value)) {
      places.push(at);
      const items = value.map((item, index) => walk(item, [...at, String(index)]));
      return { raw: items.map((item) => item.raw), parsed: items.map((item) => item.parsed) };
    }
    if (typeof value !== "object" || value === null) return { raw: value, parsed: value };
    places.push(at);
    const dropping = options.drops !== false && tc.draw(gs.booleans());
    const own = Object.keys(value);
    const added = dropping && options.widen === true ? ["a", "b", "ab"].filter((key) => !own.includes(key) && tc.draw(gs.booleans())) : [];
    const dropped = dropping && options.widen !== true ? own.filter(() => tc.draw(gs.booleans())) : added;
    const raw: Record<string, unknown> = {};
    const parsed: Record<string, unknown> = {};
    for (const key of own) {
      const item = (value as Record<string, unknown>)[key];
      // A key the returns dropped is no place the parsed copy holds.
      if (dropped.includes(key)) {
        raw[key] = structuredClone(item);
        continue;
      }
      const inner = walk(item, [...at, key]);
      raw[key] = inner.raw;
      parsed[key] = inner.parsed;
    }
    for (const key of added) raw[key] = tc.draw(leaf);
    if (dropping) declared.set(placeKey(at), [...Object.keys(parsed), ...(tc.draw(gs.booleans()) ? [UNRETURNED_KEY] : [])]);
    if (dropped.length > 0) measured.push({ at, keys: dropped });
    return { raw, parsed };
  };
  const { raw, parsed } = walk(value, ["out"]);
  if (options.unrecorded) return { raw, parsed, measured: undefined, declared };
  if (!options.unseen || places.length === 0) return { raw, parsed, measured, declared };
  const unseen = tc.draw(gs.arrays(gs.sampledFrom(places), { minSize: 1, maxSize: 2 }));
  const inside = (at: readonly string[], place: readonly string[]): boolean => place.length <= at.length && place.every((segment, index) => at[index] === segment);
  const kept = measured.filter((entry) => !unseen.some((place) => inside(entry.at, place)));
  return { raw, parsed, measured: [...kept, ...unseen.map((at) => ({ at, unmeasured: "a test names it" }))], declared };
}

const NO_STEP = {} as Step;

/** `ClaimInputs.droppedAt` for the from keys `produced` fills: the run's
 * own `droppedKeysAt` over a record's `returns_dropped`, and the keys an
 * object schema declares for a record without it. */
function droppedAtOf(produced: Readonly<Record<string, Produced>>): (segments: readonly string[]) => DroppedKeys | null {
  return (segments) => {
    const [key, ...path] = segments;
    const from = key === undefined ? undefined : produced[key];
    if (from === undefined) return null;
    const step = `make-${key!}`;
    if (from.measured !== undefined) {
      const filled: FilledFrom = { step: NO_STEP, stepName: step, key: "out", dropped: from.measured };
      return droppedKeysAt(new Map([[key!, filled]]), segments);
    }
    const declared = from.declared.get(placeKey(["out", ...path]));
    return declared === undefined ? null : { step, declared };
  };
}

const testInProcess: PatternTester = async (pattern, text) => {
  const built = new RegExp(pattern);
  return { holds: built.test(text), matchesEmpty: built.test("") };
};

const FROM_KEYS = ["v", "w", "user"];

function inputs(args: Record<string, unknown>, droppedAt?: ClaimInputs["droppedAt"]): ClaimInputs {
  return {
    args: readerNow(args),
    observed: readerNow({}),
    schemaChanged: () => null,
    observeReceived: [],
    fromKeys: new Set(FROM_KEYS),
    argSide: (key) =>
      FROM_KEYS.includes(key) ? { origin: `record:make-${key}`, segments: ["out"], label: `from:make-${key}@3.out` } : { origin: `sentence:${key}`, segments: [], label: `sentence:${key}` },
    sentenceText: (key) => (FROM_KEYS.includes(key) ? null : `text of ${key}`),
    ...(droppedAt === undefined ? {} : { droppedAt }),
    patterns: ["the value is {want}"],
    testPattern: testInProcess,
    budget: judgingBudget(Number.POSITIVE_INFINITY, "a test's budget"),
  };
}

type JudgedRecord = ClaimComparisonRecord | ClaimEachRecord;

async function judge(claim: Claim, args: Record<string, unknown>, droppedAt?: ClaimInputs["droppedAt"]): Promise<JudgedRecord> {
  const [judged] = await evaluateClaims([claim], inputs(args, droppedAt));
  return judged!.record;
}

/** Whether a record, or an item record inside it, was left unjudged for
 * a key a producer's `returns` dropped. */
const DROP_REASON = /(its returns dropped (it|them)|could not see which keys the returns of step|does not say which keys its returns dropped).*?, and the claim was not judged/;

const DROP_COMPARES: readonly ClaimCompare[] = ["equal", "not-equal", "has-item", "has-same-items", "has-fields", "lacks-field"];
// Compares a dropped key never changes: a text, a number, or a kind.
const OTHER_COMPARES: readonly ClaimCompare[] = ["is-a", "contains-text", "at-least"];

/** The value at `path` inside `value`, or `undefined`. */
function at(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The JSON type a compare reads its actual value as, where it reads one. */
const READS: Partial<Record<ClaimCompare, "object" | "array">> = { "lacks-field": "object", "has-fields": "object", "has-item": "array", "has-same-items": "array" };

/** Every path inside `value`, its own empty path included. */
function pathsIn(value: unknown, path: readonly string[] = []): string[][] {
  const inner = typeof value === "object" && value !== null ? Object.entries(value).flatMap(([key, item]) => pathsIn(item, [...path, key])) : [];
  return [[...path], ...inner];
}

/** A path inside `value` to a value of the type `compare` reads, when
 * `value` holds one. */
function pathFor(tc: hegel.TestCase, compare: ClaimCompare, value: unknown): string[] {
  const reads = READS[compare];
  const all = pathsIn(value);
  const fitting = all.filter((path) => {
    const found = at(value, path);
    if (reads === "array") return Array.isArray(found);
    if (reads === "object") return typeof found === "object" && found !== null && !Array.isArray(found);
    return true;
  });
  return tc.draw(gs.sampledFrom(fitting.length === 0 ? all : fitting));
}

/** One of `choices`, drawn by weight. */
function weighted<T>(tc: hegel.TestCase, choices: readonly (readonly [number, () => T])[]): T {
  let roll = tc.draw(gs.integers({ minValue: 0, maxValue: choices.reduce((sum, [weight]) => sum + weight, 0) - 1 }));
  for (const [weight, choose] of choices) {
    if (roll < weight) return choose();
    roll -= weight;
  }
  throw new Error("a roll past every weight");
}

/** Some of the fields of a value, at any depth, for `has-fields`. */
function someFields(tc: hegel.TestCase, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => someFields(tc, item));
  if (typeof value !== "object" || value === null) return value;
  const kept: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (tc.draw(gs.booleans())) kept[key] = someFields(tc, item);
  return kept;
}

const keysOf = (value: unknown): string[] => (typeof value === "object" && value !== null && !Array.isArray(value) ? Object.keys(value) : []);

/** A value to compare with an actual value the step returned as `raw`
 * and its `returns` parsed as `parsed`: most often one the claim holds on,
 * on either, and otherwise any value. */
function expectedFor(tc: hegel.TestCase, compare: ClaimCompare, raw: unknown, parsed: unknown): unknown {
  const any = (): unknown => tc.draw(jsonValue(2));
  const item = (value: unknown): unknown => (Array.isArray(value) && value.length > 0 ? structuredClone(tc.draw(gs.sampledFrom(value))) : any());
  const reversed = (value: unknown): unknown => (Array.isArray(value) ? structuredClone(value).reverse() : any());
  switch (compare) {
    case "lacks-field": {
      const dropped = keysOf(raw).filter((key) => !keysOf(parsed).includes(key));
      return weighted<unknown>(tc, [
        [2, () => (dropped.length > 0 ? tc.draw(gs.sampledFrom(dropped)) : UNRETURNED_KEY)],
        [1, () => (keysOf(parsed).length > 0 ? tc.draw(gs.sampledFrom(keysOf(parsed))) : "a")],
        [1, () => tc.draw(gs.sampledFrom(["a", UNRETURNED_KEY]))],
      ]);
    }
    case "equal":
      return weighted(tc, [[3, () => structuredClone(parsed)], [1, () => structuredClone(raw)], [1, any]]);
    case "not-equal":
      return weighted(tc, [[2, () => structuredClone(raw)], [1, () => someFields(tc, structuredClone(parsed))], [1, () => structuredClone(parsed)], [1, any]]);
    case "has-item":
      return weighted(tc, [[3, () => item(parsed)], [1, () => item(raw)], [1, any]]);
    case "has-same-items":
      return weighted(tc, [[3, () => reversed(parsed)], [1, () => reversed(raw)], [1, any]]);
    case "has-fields":
      return weighted(tc, [[3, () => someFields(tc, structuredClone(parsed))], [2, () => someFields(tc, structuredClone(raw))], [1, any]]);
    default:
      return any();
  }
}

interface Drawn {
  readonly claim: Claim;
  readonly v: Produced;
  readonly w: Produced | null;
  readonly sentence: Record<string, unknown>;
}

/** A claim on `v`, whose expected value the sentence states or an earlier
 * step returned (`w`, which may have had keys dropped too). */
function drawClaim(
  tc: hegel.TestCase,
  options: { readonly unseen: boolean; readonly unrecorded: boolean; readonly expectedFrom: boolean; readonly each: boolean; readonly where: boolean },
): Drawn {
  // A side that drops nothing a quarter of the time, so a key dropped from
  // one side only is drawn as often as one dropped from both.
  const producing = (): ProduceOptions => ({ ...options, widen: tc.draw(gs.booleans()), drops: tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) > 0 });
  const v = produce(tc, tc.draw(options.each || tc.draw(gs.booleans()) ? alikeItems : container(3)), producing());
  const compares = [...DROP_COMPARES, ...OTHER_COMPARES];
  const sentence: Record<string, unknown> = {};
  let w: Produced | null = null;
  /** A comparison on the value at a path of `raw` and `parsed`. */
  const comparison = (name: string, raw: unknown, parsed: unknown): { path: string[]; compare: ClaimCompare; expected: ItemClaim["expected"] } => {
    const compare = tc.draw(gs.sampledFrom(compares));
    const path = pathFor(tc, compare, parsed);
    const rawAt = at(raw, path);
    const parsedAt = at(parsed, path);
    if (options.expectedFrom && compare !== "lacks-field" && w === null) {
      w = produce(tc, expectedFor(tc, compare, rawAt, parsedAt), producing());
      return { path, compare, expected: { from: "w" } };
    }
    sentence[name] = expectedFor(tc, compare, rawAt, parsedAt);
    return { path, compare, expected: name };
  };
  if (!options.each) {
    const { path, compare, expected } = comparison("want", v.raw, v.parsed);
    return { claim: { actual: ["v", ...path].join("."), compare, expected }, v, w, sentence };
  }
  const items = v.parsed as unknown[];
  const itemClaim = (name: string): ItemClaim => {
    const index = tc.draw(gs.integers({ minValue: 0, maxValue: items.length - 1 }));
    const { path, compare, expected } = comparison(name, (v.raw as unknown[])[index], items[index]);
    return { ...(path.length === 0 ? {} : { actual: path.join(".") }), compare, expected };
  };
  const where = options.where ? [itemClaim("where")] : undefined;
  const claims = [itemClaim("want")];
  return { claim: { actual: "v", each: { ...(where === undefined ? {} : { where }), claims } }, v, w, sentence };
}

const optionsOf = (tc: hegel.TestCase) => ({
  unseen: tc.draw(gs.booleans()),
  unrecorded: tc.draw(gs.booleans()),
  expectedFrom: tc.draw(gs.booleans()),
  each: tc.draw(gs.booleans()),
  where: tc.draw(gs.booleans()),
});

const argsOf = (drawn: Drawn, side: "raw" | "parsed"): Record<string, unknown> => ({
  ...drawn.sentence,
  v: drawn.v[side],
  ...(drawn.w === null ? {} : { w: drawn.w[side] }),
});

const producedOf = (drawn: Drawn): Record<string, Produced> => ({ v: drawn.v, ...(drawn.w === null ? {} : { w: drawn.w }) });

describe("a claim on a value a producer's returns dropped keys from", () => {
  it("holds only where it holds on the value as the steps returned it", () =>
    hegel.testAsync(
      async (tc) => {
        const drawn = drawClaim(tc, optionsOf(tc));
        const judged = await judge(drawn.claim, argsOf(drawn, "parsed"), droppedAtOf(producedOf(drawn)));
        if (judged.outcome !== "held") return;
        const asReturned = await judge(drawn.claim, argsOf(drawn, "raw"));
        expect(asReturned.outcome, JSON.stringify({ judged, asReturned })).toBe("held");
      },
      { testCases: 1000 },
    ));

  it("comes out otherwise than on the parsed copy alone only as unjudged, for a key dropped there", () =>
    hegel.testAsync(
      async (tc) => {
        const drawn = drawClaim(tc, optionsOf(tc));
        const args = argsOf(drawn, "parsed");
        const judged = await judge(drawn.claim, args, droppedAtOf(producedOf(drawn)));
        const alone = await judge(drawn.claim, args);
        if (judged.outcome === alone.outcome) return;
        expect(judged.outcome).toBe("unjudged");
        expect(JSON.stringify(judged)).toMatch(DROP_REASON);
      },
      { testCases: 1000 },
    ));

  it("is judged on the parsed copy alone, record and all, where the producer dropped nothing", () =>
    hegel.testAsync(
      async (tc) => {
        const options = { ...optionsOf(tc), unseen: false, unrecorded: false };
        const drawn = drawClaim(tc, options);
        const undropped = { ...drawn, v: produce(tc, drawn.v.raw, { ...options, drops: false }), w: drawn.w === null ? null : produce(tc, drawn.w.raw, { ...options, drops: false }) };
        const args = argsOf(undropped, "parsed");
        expect(await judge(undropped.claim, args, droppedAtOf(producedOf(undropped)))).toEqual(await judge(undropped.claim, args));
      },
      { testCases: 300 },
    ));

  it("is left unjudged for a dropped key only where some value the step could have returned breaks it", () =>
    hegel.testAsync(
      async (tc) => {
        // The record names each key, the sentence states the expected
        // value, and nothing but the actual side had a key dropped, so a
        // value the step could have returned is the parsed copy with each
        // dropped key put back.
        const drawn = drawClaim(tc, { unseen: false, unrecorded: false, expectedFrom: false, each: tc.draw(gs.booleans()), where: false });
        const args = argsOf(drawn, "parsed");
        const judged = await judge(drawn.claim, args, droppedAtOf(producedOf(drawn)));
        if (judged.outcome !== "unjudged" || !DROP_REASON.test(JSON.stringify(judged))) return;
        // A value no sentence states, unless a not-equal is judged: then
        // the one the expected value holds there, so the sides may meet.
        const claim = drawn.claim;
        const judgedOn = isComparison(claim) ? claim : claim.each.claims[0]!;
        const claimPath = (judgedOn.actual ?? "").split(".").filter((segment) => segment !== "").slice(isComparison(claim) ? 1 : 0);
        // The path inside the value compared, past v and, for an each, past
        // the item's index.
        const inCompared = (place: readonly string[]): readonly string[] | null => {
          const start = isComparison(claim) ? 1 : 2;
          const prefix = place.slice(start, start + claimPath.length);
          return prefix.length === claimPath.length && prefix.every((segment, index) => segment === claimPath[index]) ? place.slice(start + claimPath.length) : null;
        };
        let fresh = 0;
        const witness = structuredClone(drawn.v.parsed);
        for (const drop of drawn.v.measured!) {
          if (!("keys" in drop)) continue;
          const object = at(witness, drop.at.slice(1)) as Record<string, unknown>;
          const rel = judgedOn.compare === "not-equal" ? inCompared(drop.at) : null;
          for (const key of drop.keys) {
            const inExpected = rel === null ? undefined : at(drawn.sentence.want, [...rel, key]);
            object[key] = inExpected === undefined ? `fresh ${fresh++}` : structuredClone(inExpected);
          }
        }
        const asReturned = await judge(drawn.claim, { ...args, v: witness });
        expect(asReturned.outcome, JSON.stringify({ judged, witness })).not.toBe("held");
      },
      { testCases: 1000 },
    ));
});

describe("a where clause on a value a producer's returns dropped keys from", () => {
  it("selects the items it selects on the value as the steps returned it, or leaves the each unjudged", () =>
    hegel.testAsync(
      async (tc) => {
        const drawn = drawClaim(tc, { ...optionsOf(tc), each: true, where: true });
        const judged = (await judge(drawn.claim, argsOf(drawn, "parsed"), droppedAtOf(producedOf(drawn)))) as ClaimEachRecord;
        // A where clause that could not compare at all ends the each as
        // broken, which says nothing of which items it selects.
        if (judged.reason?.startsWith("where could not") === true) return;
        const asReturned = (await judge(drawn.claim, argsOf(drawn, "raw"))) as ClaimEachRecord;
        const selectedAsReturned = new Map((asReturned.each?.results ?? []).map((result) => [result.index, result.selected]));
        for (const result of judged.each?.results ?? []) {
          const selected = selectedAsReturned.get(result.index);
          if (selected !== undefined) expect(result.selected, JSON.stringify({ judged, asReturned })).toBe(selected);
        }
      },
      { testCases: 1000 },
    ));
});

function isComparison(claim: Claim): claim is Extract<Claim, { compare: ClaimCompare }> {
  return claim.each === undefined;
}

describe("the reason a claim on a dropped key names", () => {
  const user = { name: "aki" };
  const measured = (dropped: ReturnsDrop[] | undefined, returns: z.ZodTypeAny = z.object({ user: z.object({ name: z.string() }) })) => {
    const filled = new Map<string, FilledFrom>([["user", { step: { returns } as unknown as Step, stepName: "a-user-signs-up", key: "user", dropped }]]);
    return (segments: readonly string[]) => droppedKeysAt(filled, segments);
  };

  it("names the step, the place, and the key the record names", async () => {
    const droppedAt = measured([{ at: ["user"], keys: ["password"] }]);
    expect(await judge({ actual: "user", compare: "lacks-field", expected: { literal: "password" } }, { user }, droppedAt)).toMatchObject({
      outcome: "unjudged",
      reason: 'step "a-user-signs-up" returned password at from:make-user@3.out, and its returns dropped it, so the password field was there, and the claim was not judged',
    });
    expect(await judge({ actual: "user", compare: "equal", expected: "want" }, { user, want: { name: "aki" } }, droppedAt)).toMatchObject({
      outcome: "unjudged",
      reason: 'step "a-user-signs-up" returned password at from:make-user@3.out, and its returns dropped it, so the two values differed as returned, and the claim was not judged',
    });
    expect(await judge({ actual: "user", compare: "not-equal", expected: "want" }, { user, want: { name: "aki", password: "x" } }, droppedAt)).toMatchObject({
      outcome: "unjudged",
      reason: 'step "a-user-signs-up" returned password at from:make-user@3.out, and its returns dropped it, so the two values may have been equal as returned, and the claim was not judged',
    });
  });

  it("judges a claim no dropped key could change, and one on a key the object kept", async () => {
    const droppedAt = measured([{ at: ["user"], keys: ["password"] }]);
    for (const [claim, args, outcome] of [
      [{ actual: "user", compare: "lacks-field", expected: { literal: "email" } }, { user }, "held"],
      [{ actual: "user", compare: "has-fields", expected: "want" }, { user, want: { name: "aki" } }, "held"],
      [{ actual: "user", compare: "not-equal", expected: "want" }, { user, want: { name: "kei", password: "x" } }, "held"],
      [{ actual: "user", compare: "not-equal", expected: "want" }, { user, want: { name: "aki", email: "x" } }, "held"],
      [{ actual: "user.name", compare: "equal", expected: "want" }, { user, want: "aki" }, "held"],
      [{ actual: "user", compare: "equal", expected: "want" }, { user, want: { name: "kei" } }, "broken"],
    ] as const) {
      expect(await judge(claim as Claim, args, droppedAt), JSON.stringify(claim)).toMatchObject({ outcome });
    }
  });

  it("holds a not-equal the keys it knows were dropped could not make equal", async () => {
    // Two arrays of other lengths.
    const items = measured([{ at: ["user", "0"], keys: ["password"] }]);
    // One item equal to the expected value as returned is enough, whichever
    // other item had a key dropped.
    for (const [users, outcome] of [
      [[user, user], "held"],
      [[user, { name: "kei" }], "unjudged"],
    ] as const) {
      expect(await judge({ actual: "user", compare: "has-item", expected: "want" }, { user: users, want: user }, items)).toMatchObject({ outcome });
    }
    expect(await judge({ actual: "user", compare: "not-equal", expected: "want" }, { user: [user], want: [{ name: "aki", password: "x" }, { name: "kei" }] }, items)).toMatchObject({ outcome: "held" });
    // A key the step returned at the top, which the expected value lacks,
    // while a key dropped below may account for the one difference there.
    const nested = measured([
      { at: ["user"], keys: ["password"] },
      { at: ["user", "profile"], keys: ["bio"] },
    ]);
    expect(await judge({ actual: "user", compare: "not-equal", expected: "want" }, { user: { profile: {} }, want: { profile: { bio: "b" } } }, nested)).toMatchObject({ outcome: "held" });
    expect(await judge({ actual: "user", compare: "not-equal", expected: "want" }, { user: { profile: {} }, want: { profile: { bio: "b" }, password: "p" } }, nested)).toMatchObject({
      outcome: "unjudged",
    });
    // An object, whatever keys were dropped from it, is not an array.
    const unseen = measured([{ at: ["user"], unmeasured: "a test names it" }]);
    expect(await judge({ actual: "user", compare: "not-equal", expected: "want" }, { user: { tags: {} }, want: { tags: [] } }, unseen)).toMatchObject({ outcome: "held" });
    expect(await judge({ actual: "user", compare: "not-equal", expected: "want" }, { user, want: { name: "aki", password: "x" } }, unseen)).toMatchObject({ outcome: "unjudged" });
  });

  it("names the place the record could not see into, and the reason it gives", async () => {
    const droppedAt = measured([{ at: ["user"], unmeasured: "the step returned a Proxy at user, which nukadoko does not read" }]);
    expect(await judge({ actual: "user", compare: "lacks-field", expected: { literal: "password" } }, { user }, droppedAt)).toMatchObject({
      outcome: "unjudged",
      reason:
        'nukadoko could not see which keys the returns of step "a-user-signs-up" dropped at from:make-user@3.out (the step returned a Proxy at user, which nukadoko does not read), so a password field may have been there, and the claim was not judged',
    });
  });

  it("names, for a record without the field, the keys the object schema declares", async () => {
    const droppedAt = measured(undefined);
    expect(await judge({ actual: "user", compare: "lacks-field", expected: { literal: "password" } }, { user }, droppedAt)).toMatchObject({
      outcome: "unjudged",
      reason:
        'the record of step "a-user-signs-up" does not say which keys its returns dropped, and its returns parses from:make-user@3.out with an object schema that declares name and drops any key it does not declare, so a password field may have been there, and the claim was not judged',
    });
    // A field the schema declares is one it never drops.
    expect(await judge({ actual: "user", compare: "lacks-field", expected: { literal: "name" } }, { user: {} }, droppedAt)).toMatchObject({ outcome: "held" });
    for (const returns of [z.object({ user: z.looseObject({ name: z.string() }) }), z.object({ user: z.strictObject({ name: z.string() }) })]) {
      expect(await judge({ actual: "user", compare: "lacks-field", expected: { literal: "password" } }, { user }, measured(undefined, returns))).toMatchObject({ outcome: "held" });
    }
  });

  it("reads no drop past a view or a count, which make a value of their own", async () => {
    const droppedAt = measured([{ at: ["user"], unmeasured: "a test names it" }]);
    const args = { user: { tags: [{ id: 1 }], bio: '{"id":1}' } };
    expect(await judge({ actual: "user.tags", count: true, compare: "equal", expected: { literal: 1 } }, args, droppedAt)).toMatchObject({ outcome: "held" });
    expect(await judge({ actual: "user.tags", compare: "equal", expected: "want" }, { ...args, want: [{ id: 1 }] }, droppedAt)).toMatchObject({ outcome: "unjudged" });
    expect(await judge({ actual: "user.bio", view: "json", compare: "equal", expected: "want" }, { ...args, want: { id: 1 } }, droppedAt)).toMatchObject({ outcome: "held" });
  });

  it("stops an each at the item whose where clause a dropped key could change, and judges the each item by item otherwise", async () => {
    const users = [{ name: "aki" }, { name: "kei" }];
    const droppedAt = measured([{ at: ["user", "0"], keys: ["role"] }]);
    const where = await judge({ actual: "user", each: { where: [{ compare: "lacks-field", expected: { literal: "role" } }], claims: [{ actual: "name", compare: "is-a", expected: { literal: "text" } }] } }, { user: users }, droppedAt);
    expect(where).toMatchObject({
      outcome: "unjudged",
      reason:
        'where could not judge item 0: step "a-user-signs-up" returned role at from:make-user@3.out.0, and its returns dropped it, so the role field was there, and the claim was not judged',
    });
    const items = await judge({ actual: "user", each: { claims: [{ compare: "lacks-field", expected: { literal: "role" } }] } }, { user: users }, droppedAt);
    expect(items).toMatchObject({ outcome: "unjudged", each: { selected: 2, results: [{ index: 0, outcome: "unjudged" }, { index: 1, outcome: "held" }] } });
    // The line names the item it could not judge, and why.
    const why = 'step "a-user-signs-up" returned role at from:make-user@3.out.0, and its returns dropped it, so the role field was there, and the claim was not judged';
    expect(claimLine(items)).toBe(`each of from:make-user@3.out (2 items): item lacks-field "role" (literal:unstated) unjudged; item 0: {"name":"aki"} (from:make-user@3.out.0) lacks-field "role" (literal:unstated): ${why}`);
    expect(brokenClaimsMessage([items])).toBe(
      `claim unjudged: each of from:make-user@3.out (2 items): item lacks-field "role" (literal:unstated)\n  item 0: {"name":"aki"} (from:make-user@3.out.0) lacks-field "role" (literal:unstated) unjudged: ${why}`,
    );
    const broken = await judge({ actual: "user", each: { claims: [{ compare: "lacks-field", expected: { literal: "name" } }] } }, { user: users }, droppedAt);
    expect(broken).toMatchObject({ outcome: "broken" });
  });

  it("leaves out an item no dropped key could have selected, and stops at one a dropped key could have", async () => {
    const tagged = measured([{ at: ["user", "0", "tags", "0"], keys: ["x"] }]);
    const args = { user: [{ name: "aki", tags: [{ id: 1 }] }] };
    const isText = [{ actual: "name", compare: "is-a" as const, expected: { literal: "text" } }];
    // Two arrays of other lengths are never the same items.
    expect(await judge({ actual: "user", each: { where: [{ actual: "tags", compare: "has-same-items", expected: "want" }], claims: isText } }, { ...args, want: [{ id: 1 }, { id: 2 }] }, tagged)).toMatchObject({
      outcome: "broken",
      reason: "where selected none of the 1 items, and a claim on none of them measures nothing",
    });
    for (const where of [
      { actual: "tags", compare: "has-same-items" as const, expected: "want" },
      { actual: "tags", compare: "has-item" as const, expected: "item" },
      { actual: "tags.0", compare: "has-fields" as const, expected: "item" },
      { actual: "tags.0", compare: "equal" as const, expected: "item" },
    ]) {
      const judged = await judge({ actual: "user", each: { where: [where], claims: isText } }, { ...args, want: [{ id: 1, x: 2 }], item: { id: 1, x: 2 } }, tagged);
      expect(judged, JSON.stringify(where)).toMatchObject({ outcome: "unjudged" });
      expect((judged as ClaimEachRecord).reason, JSON.stringify(where)).toMatch(/^where could not judge item 0: step "a-user-signs-up" returned x at from:make-user@3\.out\.0\.tags\.0, and its returns dropped it/);
    }
  });
});

describe("what a producer's record says it dropped at a place", () => {
  const filled = (dropped: ReturnsDrop[] | undefined) =>
    new Map<string, FilledFrom>([["user", { step: { returns: z.object({ out: z.object({ name: z.string(), tags: z.array(z.looseObject({})) }) }) } as unknown as Step, stepName: "s", key: "out", dropped }]]);

  it("is the unmeasured entry that covers the place, then the entry at the place, and nothing elsewhere", () => {
    const dropped: ReturnsDrop[] = [
      { at: ["out"], keys: ["password"] },
      { at: ["out", "tags"], unmeasured: "why" },
    ];
    expect(droppedKeysAt(filled(dropped), ["user"])).toEqual({ step: "s", keys: ["password"] });
    expect(droppedKeysAt(filled(dropped), ["user", "tags"])).toEqual({ step: "s", unseen: "why" });
    expect(droppedKeysAt(filled(dropped), ["user", "tags", "0"])).toEqual({ step: "s", unseen: "why" });
    expect(droppedKeysAt(filled(dropped), ["user", "name"])).toBeNull();
    expect(droppedKeysAt(filled(dropped), ["other"])).toBeNull();
    expect(droppedKeysAt(filled([]), ["user"])).toBeNull();
    // Two paths whose segments spell the same text are two places.
    expect(droppedKeysAt(filled([{ at: ["out", "ab"], keys: ["x"] }]), ["user", "a", "b"])).toBeNull();
    expect(droppedKeysAt(filled([{ at: ["out", "a"], unmeasured: "why" }]), ["user", "ab"])).toBeNull();
  });

  it("is, for a record without the field, the keys a dropping object schema there declares", () => {
    expect(droppedKeysAt(filled(undefined), ["user"])).toEqual({ step: "s", declared: ["name", "tags"] });
    expect(droppedKeysAt(filled(undefined), ["user", "tags", "0"])).toBeNull();
  });

  it("reads back what a record holds, and nothing from a field of another shape", () => {
    const dropped = [{ at: ["out"], keys: ["password"] }, { at: ["out", "tags"], unmeasured: "why" }];
    expect(readReturnsDropped(dropped)).toEqual(dropped);
    expect(readReturnsDropped([])).toEqual([]);
    for (const malformed of [undefined, null, {}, [{ at: "out", keys: ["a"] }], [{ at: ["out"], keys: [] }], [{ at: ["out"], keys: [1] }], [{ at: ["out"] }], [{ at: ["out"], keys: ["a"], unmeasured: "b" }]]) {
      expect(readReturnsDropped(malformed), JSON.stringify(malformed)).toBeUndefined();
    }
    expect(readReturnsDropped([{ at: ["out"], keys: ["{{secret.TOKEN}}"] }])).toEqual([{ at: ["out"], unmeasured: "the record names a key it dropped there only as a redacted secret" }]);
  });
});
