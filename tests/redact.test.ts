import { describe, expect, it } from "vitest";
import { redact, redactString } from "../src/secrets/redact.js";
import type { SecretEntry } from "../src/secrets/types.js";

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
