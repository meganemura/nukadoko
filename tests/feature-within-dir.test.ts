import { describe, expect, it } from "vitest";
import { isFeatureWithinDir } from "../src/tend/feature-within-dir.js";

// Responsibility: src/tend/feature-within-dir.ts's one function, in
// isolation — the normalization every featuresDir placement check in
// src/tend/signoff-rot.ts and src/tend/signoff-condition-mismatch.ts shares.
// End-to-end coverage of the same bug class already exists in
// tests/signoff-rot-featuresdir.test.ts (a real `nuka run` + `nuka accept`
// + `nuka tend` cycle); this file is the cheap, exhaustive complement —
// every boundary case in one process, no fixture project needed.

describe("isFeatureWithinDir", () => {
  it("is true for a feature directly inside the directory", () => {
    expect(isFeatureWithinDir("features/x.feature", "features")).toBe(true);
  });

  it("is true for a feature nested several levels inside the directory", () => {
    expect(isFeatureWithinDir("features/a/b/c.feature", "features")).toBe(true);
  });

  it("is false for a directory that only shares featuresDir's name as a string prefix", () => {
    // The exact mistake a plain `startsWith` would make:
    // "features-extra/x.feature".startsWith("features") is true, but the
    // feature is not inside "features" at all.
    expect(isFeatureWithinDir("features-extra/x.feature", "features")).toBe(false);
  });

  it("is false for a sibling directory with an unrelated name", () => {
    expect(isFeatureWithinDir("elsewhere/x.feature", "features")).toBe(false);
  });

  it("is false for the directory path itself (a directory is not a feature inside itself)", () => {
    expect(isFeatureWithinDir("features", "features")).toBe(false);
  });

  it("is false for a feature one level above the directory", () => {
    expect(isFeatureWithinDir("x.feature", "features")).toBe(false);
  });

  it("treats featuresDir \".\" as the project root, containing any relative feature path", () => {
    expect(isFeatureWithinDir("features/x.feature", ".")).toBe(true);
  });
});
