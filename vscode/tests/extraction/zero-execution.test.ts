import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { extractStepDeclarations } from "../../src/extraction/step-extraction.js";

// Responsibility: prove extractStepDeclarations never executes the source
// it is given -- reading a workspace's step files to find step declarations
// must never run them. tests/fixtures/side-effecting-step.ts writes a
// marker file the moment it is *evaluated*; this test parses that same
// source text and asserts the marker never appears.
const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "..", "fixtures");
const fixturePath = path.join(fixturesDir, "side-effecting-step.ts");
const markerPath = path.join(fixturesDir, "zero-execution-marker.txt");

afterEach(() => {
  // Defensive only: if this test ever fails because the marker *did*
  // appear, clean it up so a later run doesn't inherit a stale pass.
  if (existsSync(markerPath)) {
    rmSync(markerPath);
  }
});

describe("extractStepDeclarations: zero execution", () => {
  it("never writes the fixture's own top-level side effect", async () => {
    expect(existsSync(markerPath)).toBe(false);

    const sourceText = await readFile(fixturePath, "utf8");
    const result = await extractStepDeclarations(fixturePath, sourceText);

    // The parse itself must still succeed and find the real declaration --
    // this proves the absence of the marker file is because execution
    // never happened, not because parsing silently failed on this fixture.
    expect(result.unresolved).toEqual([]);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0]).toMatchObject({
      kind: "typed",
      pattern: "a todo titled {title:string} is added",
    });

    expect(existsSync(markerPath)).toBe(false);
  });
});
