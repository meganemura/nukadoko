import { describe, expect, it } from "vitest";
import { resolveStaticPattern } from "nukadoko/matching";

describe("resolveStaticPattern", () => {
  it("resolves a typed pattern with a named capture, and matches() reports it", () => {
    const resolution = resolveStaticPattern({
      kind: "typed",
      pattern: "a project {name:string} exists",
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("expected ok: true");
    expect(resolution.matches('a project "acme" exists')).toBe(true);
    expect(resolution.matches("something else entirely")).toBe(false);
  });

  it("resolves to ok: false with a traceable reason for an unknown parameter type", () => {
    const resolution = resolveStaticPattern({
      kind: "typed",
      pattern: "a {value:unknown} thing",
    });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("expected ok: false");
    expect(resolution.reason).toContain("Undefined parameter type 'unknown'");
  });

  it("resolves to ok: false for a pattern whose capture name is broken", () => {
    // `{string}` with no `:name` at all: stripCaptureNames' own
    // UnnamedCaptureError case (src/binding/pattern.ts).
    const resolution = resolveStaticPattern({
      kind: "typed",
      pattern: "a project {string} exists",
    });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("expected ok: false");
    expect(resolution.reason).toContain("has no name");
  });

  it("resolves a compat string pattern as unmodified cucumber-expressions syntax, no named capture required", () => {
    const resolution = resolveStaticPattern({
      kind: "compat",
      pattern: "a project {string} exists",
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("expected ok: true");
    expect(resolution.matches('a project "acme" exists')).toBe(true);
  });

  it("resolves a compat RegExp pattern without carrying /g lastIndex state across matches() calls", () => {
    const resolution = resolveStaticPattern({
      kind: "compat",
      pattern: /^a project "([^"]+)" exists$/g,
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("expected ok: true");
    // Called against the same matching text repeatedly: a RegExp instance
    // reused across calls would advance its own lastIndex on a /g match and
    // return false every other call. A fresh RegExp per call must not.
    expect(resolution.matches('a project "acme" exists')).toBe(true);
    expect(resolution.matches('a project "acme" exists')).toBe(true);
    expect(resolution.matches('a project "acme" exists')).toBe(true);
  });

  it("resolves a compat RegExp pattern with a /y flag the same way", () => {
    const resolution = resolveStaticPattern({
      kind: "compat",
      pattern: /a project "([^"]+)" exists/y,
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("expected ok: true");
    expect(resolution.matches('a project "acme" exists')).toBe(true);
    expect(resolution.matches('a project "acme" exists')).toBe(true);
  });
});
