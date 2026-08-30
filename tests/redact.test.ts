import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { TestCase } from "@hegeldev/hegel";
import { redact, redactString } from "../src/secrets/redact.js";
import { MIN_REDACTABLE_LENGTH, type SecretEntry } from "../src/secrets/types.js";

describe("redactString", () => {
  it("replaces every occurrence of a secret value with {{secret.NAME}}", () => {
    const secrets: SecretEntry[] = [{ name: "TOKEN", value: "sekrit-value" }];
    expect(redactString("Bearer sekrit-value and sekrit-value again", secrets)).toBe(
      "Bearer {{secret.TOKEN}} and {{secret.TOKEN}} again",
    );
  });

  it("leaves a value shorter than 4 characters unredacted", () => {
    const secrets: SecretEntry[] = [{ name: "SHORT", value: "abc" }];
    expect(redactString("value is abc here", secrets)).toBe("value is abc here");
  });

  it("redacts a value exactly at the 4-character minimum", () => {
    const secrets: SecretEntry[] = [{ name: "MIN", value: "abcd" }];
    expect(redactString("value is abcd here", secrets)).toBe(
      "value is {{secret.MIN}} here",
    );
  });

  it("substitutes the longer of two overlapping values first", () => {
    // If the shorter value ("pass") were substituted first, it would eat
    // part of every occurrence of the longer one ("password123") and leave
    // a mangled, partially-redacted result behind instead of one clean
    // token.
    const secrets: SecretEntry[] = [
      { name: "SHORT", value: "pass" },
      { name: "LONG", value: "password123" },
    ];
    expect(redactString("token=password123", secrets)).toBe("token={{secret.LONG}}");
  });

  it("picks the alphabetically-first key name when two keys share a value", () => {
    const secrets: SecretEntry[] = [
      { name: "ZEBRA", value: "shared-value" },
      { name: "ALPHA", value: "shared-value" },
    ];
    expect(redactString("value: shared-value", secrets)).toBe("value: {{secret.ALPHA}}");
  });

  it("is order-independent for the alphabetical tiebreak", () => {
    const secrets: SecretEntry[] = [
      { name: "ALPHA", value: "shared-value" },
      { name: "ZEBRA", value: "shared-value" },
    ];
    expect(redactString("value: shared-value", secrets)).toBe("value: {{secret.ALPHA}}");
  });

  it("is a no-op with an empty SecretSet", () => {
    expect(redactString("nothing to see here", [])).toBe("nothing to see here");
  });
});

describe("redact", () => {
  const secrets: SecretEntry[] = [{ name: "TOKEN", value: "sekrit-value" }];

  it("redacts strings found anywhere in a nested object/array structure", () => {
    const input = {
      args: { token: "sekrit-value" },
      result: { nested: ["ok", "sekrit-value", { deep: "sekrit-value-suffix" }] },
      error: undefined,
    };
    expect(redact(input, secrets)).toEqual({
      args: { token: "{{secret.TOKEN}}" },
      result: {
        nested: ["ok", "{{secret.TOKEN}}", { deep: "{{secret.TOKEN}}-suffix" }],
      },
      error: undefined,
    });
  });

  it("passes non-string leaves through unchanged: numbers, booleans, null", () => {
    const input = { count: 3, ok: true, missing: null, list: [1, false, null] };
    expect(redact(input, secrets)).toEqual(input);
  });

  it("does not mutate the input value", () => {
    const input = { token: "sekrit-value" };
    const output = redact(input, secrets);
    expect(input.token).toBe("sekrit-value");
    expect(output).not.toBe(input);
  });

  it("redacts a bare string value directly (not just object/array containers)", () => {
    expect(redact("sekrit-value", secrets)).toBe("{{secret.TOKEN}}");
  });

  it("redacts a secret found inside an object key, not just its value", () => {
    const input = { ["prefix-sekrit-value-suffix"]: 1 };
    expect(redact(input, secrets)).toEqual({ "prefix-{{secret.TOKEN}}-suffix": 1 });
  });

  it("redacts a key-borne secret nested inside an array of objects", () => {
    const input = [{ ["k-sekrit-value"]: 1 }, { plain: 2 }];
    expect(redact(input, secrets)).toEqual([{ "k-{{secret.TOKEN}}": 1 }, { plain: 2 }]);
  });

  it("redacts a key-borne secret nested inside an object inside an object", () => {
    const input = { outer: { ["sekrit-value-inner"]: "ok" } };
    expect(redact(input, secrets)).toEqual({ outer: { "{{secret.TOKEN}}-inner": "ok" } });
  });

  it("throws instead of silently dropping a key when two keys collide after redaction", () => {
    // Two SecretSet entries can share a name while differing in value (the
    // executor doesn't dedupe by name before calling redact). Both then
    // resolve to the identical `{{secret.NAME}}` token, so two distinct
    // keys carrying those two different secrets collapse to one string.
    // Picking a winner and dropping the other key's subtree would violate
    // this tool's "nothing breaks silently" rule and hand back a step
    // record silently missing data. Failing loudly surfaces the malformed
    // SecretSet instead.
    const colliding: SecretEntry[] = [
      { name: "SAME", value: "aaaa" },
      { name: "SAME", value: "bbbb" },
    ];
    const input = { aaaa: 1, bbbb: 2 };
    expect(() => redact(input, colliding)).toThrow(
      'redact: keys "aaaa" and "bbbb" both redact to "{{secret.SAME}}"',
    );
  });

  it("throws when a key already spelling out a secret's token collides with a sibling key holding the raw secret", () => {
    // Reachable from a perfectly ordinary, single-entry SecretSet (unlike
    // the test above, no duplicate name is involved): the collision comes
    // from the *data*, not from a malformed SecretSet. One key already
    // spells `{{secret.TOKEN}}` as plain data (a fixture value, a template
    // string captured before its own substitution ran); a sibling key
    // holds the raw secret. Redacting the second key produces the exact
    // string the first key already was.
    const secrets: SecretEntry[] = [{ name: "TOKEN", value: "sekrit-value" }];
    const input = { "{{secret.TOKEN}}": "already a token", "sekrit-value": "raw" };
    expect(() => redact(input, secrets)).toThrow(
      'redact: keys "{{secret.TOKEN}}" and "sekrit-value" both redact to "{{secret.TOKEN}}"',
    );
  });
});

// Property-based tests below. `redact`'s own contract (see redact.ts) never
// redacts a value shorter than MIN_REDACTABLE_LENGTH, so "no secret
// survives" is scoped to secrets that clear that threshold — the generator
// itself still draws secrets of any non-empty length, including
// sub-threshold ones, because a short secret sharing a value with (or being
// a substring of) an eligible one is exactly the interaction these
// properties exist to probe (see the substring generator note below).
//
// The generator also plants secrets inside object keys, not just values
// (see `secretKey` below) — a key is now an ordinary redaction target, so a
// property claiming to cover "anywhere in the structure" has to cover keys
// too, or it is quietly scoped to the half of the tree redact.ts no longer
// treats specially. Once a key can carry a secret, two distinct original
// keys can redact to the same string, which is exactly the case
// redact.ts's redactInner throws on rather than silently dropping a
// subtree (see redact.ts and the "throws when..." unit tests above) — a
// case the properties below treat as an expected, already-covered outcome
// and skip, not a violation to report (see `redactOrSkip`).

interface NestedFixture {
  readonly structure: unknown;
  readonly secrets: SecretEntry[];
  readonly eligible: SecretEntry[];
}

function embed(tc: TestCase, value: string): string {
  // Half the time, wrap the secret inside a larger string (`"token=" +
  // secret + trailer`) instead of using it bare — redact.ts's own
  // replacement is a plain split/join over the whole string, and a secret
  // glued to unrelated surrounding text is the shape a real step record
  // (an HTTP header, a URL) actually produces.
  if (!tc.draw(gs.booleans())) return value;
  const prefix = tc.draw(gs.text());
  const suffix = tc.draw(gs.text());
  return `${prefix}${value}${suffix}`;
}

function leaf(tc: TestCase, secretValues: readonly string[]): unknown {
  const kind = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
  switch (kind) {
    case 0:
      return tc.draw(gs.integers());
    case 1:
      return tc.draw(gs.booleans());
    case 2:
      return null;
    case 3:
      return tc.draw(gs.text());
    default:
      return embed(tc, tc.draw(gs.sampledFrom(secretValues)));
  }
}

// Builds a spine of exactly `remainingDepth` nested containers (array or
// object, chosen per level), with a secret forced at the very bottom and
// random secret-or-plain branches beside each level. Hegel's default
// collection-size distribution rarely nests more than one or two levels on
// its own, so the depth is drawn explicitly and used to control the spine
// directly instead.
function buildNested(tc: TestCase, secretValues: readonly string[], remainingDepth: number): unknown {
  if (remainingDepth === 0) {
    return embed(tc, tc.draw(gs.sampledFrom(secretValues)));
  }
  const spine = buildNested(tc, secretValues, remainingDepth - 1);
  const branchCount = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
  if (tc.draw(gs.booleans())) {
    const branches: unknown[] = [];
    for (let i = 0; i < branchCount; i += 1) branches.push(leaf(tc, secretValues));
    const index = tc.draw(gs.integers({ minValue: 0, maxValue: branches.length }));
    branches.splice(index, 0, spine);
    return branches;
  }
  const result: Record<string, unknown> = { spine };
  for (let i = 0; i < branchCount; i += 1) {
    const key = tc.draw(gs.booleans()) ? secretKey(tc, i, secretValues) : `k${i}`;
    result[key] = leaf(tc, secretValues);
  }
  return result;
}

// A key with a secret embedded in it, for the property tests that need
// keys to change under redaction. The `k${index}` prefix is fixed text
// that no drawn secret value can plausibly consume, so it keeps this key
// distinct from its `k${index}` sibling (the plain-key alternative at the
// same loop position) and from the fixed "spine" key — any key collision
// the property tests below hit is one redact.ts produced, not one this
// generator introduced by drawing the same original key twice.
function secretKey(tc: TestCase, index: number, secretValues: readonly string[]): string {
  return `k${index}-${embed(tc, tc.draw(gs.sampledFrom(secretValues)))}`;
}

const nestedFixtureGen = gs.composite<NestedFixture>((tc) => {
  const broad = tc.draw(gs.text({ minSize: 1 }));
  // Guarantees at least one secret containing every metacharacter the task
  // calls out; redact.ts replaces values with String.prototype.split/join
  // rather than a RegExp, but an unconstrained text generator would almost
  // never land on a metacharacter-heavy string at any case count.
  const meta = tc.draw(gs.text({ alphabet: ".*+()[]\\$^", minSize: 1, maxSize: 20 }));
  // `base` may end up shorter than MIN_REDACTABLE_LENGTH (an "abc"), and
  // `suffix` is drawn wide enough that `combined` = base + suffix always
  // clears the threshold — recreating the exact case the spec's substring
  // example describes ("abc" is a substring of the eligible "abcdef") on
  // every run rather than by chance.
  const base = tc.draw(gs.text({ minSize: 1 }));
  const suffix = tc.draw(gs.text({ minSize: MIN_REDACTABLE_LENGTH }));
  const combined = base + suffix;
  // Guaranteed eligible so the "no secret survives" check below always has
  // at least one secret to check, even on the (rare) case where broad/
  // meta/base/combined all land under the threshold.
  const guaranteed = tc.draw(gs.text({ minSize: MIN_REDACTABLE_LENGTH }));

  const secrets: SecretEntry[] = [
    { name: "S_BROAD", value: broad },
    { name: "S_META", value: meta },
    { name: "S_BASE", value: base },
    { name: "S_COMBINED", value: combined },
    { name: "S_GUARANTEED", value: guaranteed },
  ];
  const secretValues = secrets.map((entry) => entry.value);
  const depth = tc.draw(gs.integers({ minValue: 0, maxValue: 30 }));
  const structure = buildNested(tc, secretValues, depth);
  const eligible = secrets.filter((entry) => entry.value.length >= MIN_REDACTABLE_LENGTH);
  return { structure, secrets, eligible };
});

// Walks both keys and values: a key is redacted exactly like a value is
// (redact.ts), so "no secret survives anywhere" has to check the key
// strings too, not just what Object.values sees.
function collectStrings(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(collectStrings);
  if (node !== null && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => [
      key,
      ...collectStrings(value),
    ]);
  }
  return [];
}

type Shape = "string" | "number" | "boolean" | "null" | "array" | "object";

function shapeOf(node: unknown): Shape {
  if (node === null) return "null";
  if (Array.isArray(node)) return "array";
  if (typeof node === "object") return "object";
  return typeof node as Shape;
}

// What "structure preserved" means now that a key is an ordinary
// redaction target: key *spelling* is exactly the thing allowed to
// change, so checking that original and redacted key sets are equal (the
// old assertion here) would now fail on the one case this test exists to
// exercise. What redact() still promises, and what this checks instead:
//   - every node's kind (object/array/string/number/boolean/null) is
//     unchanged at every corresponding position — redact never turns a
//     container into a leaf or a string into a number;
//   - an array's length and per-index order are unchanged — redact
//     rewrites string content, it never reorders or drops an element;
//   - an object's key *count* is unchanged — redact renames a key, it
//     never adds or drops one (short of the collision it throws on
//     instead of silently dropping a subtree, which is the caller's own
//     responsibility to avoid and is covered by the unit tests above, not
//     by this property);
//   - every original key maps forward to a key present in the redacted
//     object, and that expected key is exactly `redactString(key,
//     secrets)` — the same transform redact.ts applies to string values,
//     applied to the key text. Using the already-tested `redactString` as
//     the oracle here, rather than re-deriving the expected key by
//     re-implementing redactInner's own logic, pins down *what* the key
//     correspondence has to be without coupling this test to *how*
//     redactInner walks the tree to get there.
function assertSameShape(original: unknown, redacted: unknown, secrets: SecretEntry[]): void {
  const originalShape = shapeOf(original);
  const redactedShape = shapeOf(redacted);
  if (originalShape !== redactedShape) {
    throw new Error(`leaf type changed: ${originalShape} -> ${redactedShape}`);
  }
  if (originalShape === "array") {
    const originalArray = original as unknown[];
    const redactedArray = redacted as unknown[];
    if (originalArray.length !== redactedArray.length) {
      throw new Error(`array length changed: ${originalArray.length} -> ${redactedArray.length}`);
    }
    originalArray.forEach((item, index) => assertSameShape(item, redactedArray[index], secrets));
  } else if (originalShape === "object") {
    const originalObject = original as Record<string, unknown>;
    const redactedObject = redacted as Record<string, unknown>;
    const originalKeys = Object.keys(originalObject);
    const redactedKeyCount = Object.keys(redactedObject).length;
    if (originalKeys.length !== redactedKeyCount) {
      throw new Error(`key count changed: ${originalKeys.length} -> ${redactedKeyCount}`);
    }
    for (const key of originalKeys) {
      const expectedKey = redactString(key, secrets);
      if (!Object.prototype.hasOwnProperty.call(redactedObject, expectedKey)) {
        throw new Error(
          `key ${JSON.stringify(key)} redacts to ${JSON.stringify(expectedKey)}, missing from the result`,
        );
      }
      assertSameShape(originalObject[key], redactedObject[expectedKey], secrets);
    }
  }
}

const KEY_COLLISION_PREFIX = "redact: keys ";

// Now that a secret can land inside a key (see `secretKey`), two distinct
// original keys can redact to the same string — the case redact.ts throws
// on by design instead of silently dropping a subtree (see redact.ts's
// redactInner and the "throws when..." unit test above). That throw is
// correct behavior, not a violation for the properties below to report,
// so a case that hits it is skipped: what it looks like is already pinned
// down by its own unit tests, not by these properties.
function redactOrSkip(
  structure: unknown,
  secrets: SecretEntry[],
): { skipped: true } | { skipped: false; value: unknown } {
  try {
    return { skipped: false, value: redact(structure, secrets) };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(KEY_COLLISION_PREFIX)) {
      return { skipped: true };
    }
    throw err;
  }
}

describe("redact property-based", () => {
  it("leaves no eligible secret anywhere in the redacted result, at any depth", () => {
    hegel.test((tc) => {
      const { structure, secrets, eligible } = tc.draw(nestedFixtureGen);
      const outcome = redactOrSkip(structure, secrets);
      if (outcome.skipped) return;
      const strings = collectStrings(outcome.value);
      for (const { name, value } of eligible) {
        if (strings.some((candidate) => candidate.includes(value))) {
          throw new Error(`secret ${name} (${JSON.stringify(value)}) survived redaction`);
        }
      }
    });
  });

  it("is idempotent: redacting an already-redacted value changes nothing further", () => {
    hegel.test((tc) => {
      const { structure, secrets } = tc.draw(nestedFixtureGen);
      const once = redactOrSkip(structure, secrets);
      if (!once.skipped) {
        const twice = redact(once.value, secrets);
        expect(twice).toEqual(once.value);
      }

      const s = tc.draw(gs.text());
      const onceStr = redactString(s, secrets);
      const twiceStr = redactString(onceStr, secrets);
      expect(twiceStr).toBe(onceStr);
    });
  });

  it("preserves structure: node kind, array order, and each key's own redaction", () => {
    hegel.test((tc) => {
      const { structure, secrets } = tc.draw(nestedFixtureGen);
      const outcome = redactOrSkip(structure, secrets);
      if (outcome.skipped) return;
      assertSameShape(structure, outcome.value, secrets);
    });
  });
});
