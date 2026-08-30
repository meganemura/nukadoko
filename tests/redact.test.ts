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
});

// Property-based tests below. `redact`'s own contract (see redact.ts) never
// redacts a value shorter than MIN_REDACTABLE_LENGTH, so "no secret
// survives" is scoped to secrets that clear that threshold — the generator
// itself still draws secrets of any non-empty length, including
// sub-threshold ones, because a short secret sharing a value with (or being
// a substring of) an eligible one is exactly the interaction these
// properties exist to probe (see the substring generator note below).

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
  for (let i = 0; i < branchCount; i += 1) result[`k${i}`] = leaf(tc, secretValues);
  return result;
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

function collectStrings(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(collectStrings);
  if (node !== null && typeof node === "object") {
    return Object.values(node as Record<string, unknown>).flatMap(collectStrings);
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

function assertSameShape(original: unknown, redacted: unknown): void {
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
    originalArray.forEach((item, index) => assertSameShape(item, redactedArray[index]));
  } else if (originalShape === "object") {
    const originalKeys = Object.keys(original as Record<string, unknown>).sort();
    const redactedKeys = Object.keys(redacted as Record<string, unknown>).sort();
    if (originalKeys.join(" ") !== redactedKeys.join(" ")) {
      throw new Error(`key set changed: ${JSON.stringify(originalKeys)} -> ${JSON.stringify(redactedKeys)}`);
    }
    for (const key of originalKeys) {
      assertSameShape((original as Record<string, unknown>)[key], (redacted as Record<string, unknown>)[key]);
    }
  }
}

describe("redact property-based", () => {
  it("leaves no eligible secret anywhere in the redacted result, at any depth", () => {
    hegel.test((tc) => {
      const { structure, secrets, eligible } = tc.draw(nestedFixtureGen);
      const result = redact(structure, secrets);
      const strings = collectStrings(result);
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
      const once = redact(structure, secrets);
      const twice = redact(once, secrets);
      expect(twice).toEqual(once);

      const s = tc.draw(gs.text());
      const onceStr = redactString(s, secrets);
      const twiceStr = redactString(onceStr, secrets);
      expect(twiceStr).toBe(onceStr);
    });
  });

  it("preserves structure: key sets, array lengths, and leaf types", () => {
    hegel.test((tc) => {
      const { structure, secrets } = tc.draw(nestedFixtureGen);
      const result = redact(structure, secrets);
      assertSameShape(structure, result);
    });
  });
});
