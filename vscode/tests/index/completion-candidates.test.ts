import { describe, expect, it } from "vitest";
import { buildCompletionCandidates } from "../../src/index/completion-candidates.js";
import type { ExtractedPattern } from "../../src/extraction/index.js";

function typedPattern(pattern: string, declarationFile: string): ExtractedPattern {
  return { declarationFile, declarationPosition: { row: 0, column: 0 }, kind: "typed", pattern };
}

function compatPattern(pattern: string | RegExp, declarationFile: string): ExtractedPattern {
  return { declarationFile, declarationPosition: { row: 0, column: 0 }, kind: "compat", pattern };
}

describe("buildCompletionCandidates", () => {
  it("builds one candidate per typed pattern, with detail set to the declaration file's basename", () => {
    const candidates = buildCompletionCandidates([
      typedPattern("a {x:int} widgets", "steps/widgets.ts"),
    ]);

    expect(candidates).toEqual([{ insertText: "a {x:int} widgets", detail: "widgets.ts" }]);
  });

  it("includes a compat string pattern", () => {
    const candidates = buildCompletionCandidates([compatPattern("a {int} widgets", "steps/compat.ts")]);

    expect(candidates).toEqual([{ insertText: "a {int} widgets", detail: "compat.ts" }]);
  });

  it("drops a compat regexp pattern, since it has no literal text to insert", () => {
    const candidates = buildCompletionCandidates([compatPattern(/^a (\d+) widgets$/, "steps/compat.ts")]);

    expect(candidates).toEqual([]);
  });

  it("collapses two patterns with the same insertText into one candidate", () => {
    const candidates = buildCompletionCandidates([
      typedPattern("a {x:int} widgets", "steps/widgets.ts"),
      typedPattern("a {x:int} widgets", "steps/widgets.ts"),
    ]);

    expect(candidates).toHaveLength(1);
  });

  it("returns an empty array when given no patterns", () => {
    expect(buildCompletionCandidates([])).toEqual([]);
  });
});
