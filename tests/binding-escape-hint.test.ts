import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { escapeReservedChars } from "../src/binding/escape-hint.js";

describe("escapeReservedChars", () => {
  it("is idempotent for every string", () =>
    hegel.test((tc) => {
      const pattern = tc.draw(gs.text());
      const escaped = escapeReservedChars(pattern);
      expect(escapeReservedChars(escaped)).toBe(escaped);
    }));

  it("escapes bare parentheses in literal text", () => {
    expect(escapeReservedChars("the amount (USD) is {string}")).toBe(
      "the amount \\(USD\\) is {string}",
    );
  });

  it("escapes a bare slash", () => {
    expect(escapeReservedChars("width/height is {string}")).toBe("width\\/height is {string}");
  });

  it("leaves a pattern with no reserved characters unchanged", () => {
    expect(escapeReservedChars("a plain step with no parameters")).toBe(
      "a plain step with no parameters",
    );
  });

  it("does not escape characters inside a {type} token", () => {
    // Not realistic for a built-in type name, but the walk must treat
    // everything between { and } as opaque regardless.
    expect(escapeReservedChars("a {weird/type} thing")).toBe("a {weird/type} thing");
  });

  it("does not double-escape a character that is already escaped", () => {
    expect(escapeReservedChars("already \\(escaped\\) text")).toBe("already \\(escaped\\) text");
  });

  it("leaves a genuine optional group's parens untouched only when already escaped, otherwise still escapes bare ones", () => {
    // escapeReservedChars has no notion of "this () was intentional" — that
    // judgment is check's job (try the escaped variant, keep it only if it
    // turns a non-match into a match). This test just pins the mechanical
    // behavior: every bare occurrence gets escaped, unconditionally.
    expect(escapeReservedChars("optional (s) suffix")).toBe("optional \\(s\\) suffix");
  });
});
