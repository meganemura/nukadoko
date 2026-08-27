import { describe, expect, it } from "vitest";
import { matchStepText } from "../../src/extraction/match-declarations.js";
import type { ExtractedPattern } from "../../src/extraction/step-extraction.js";

function typedPattern(
  pattern: string,
  declarationFile: string,
  row: number,
  column: number,
): ExtractedPattern {
  return { declarationFile, declarationPosition: { row, column }, kind: "typed", pattern };
}

describe("matchStepText", () => {
  it("collapses two patterns of the same declaration into one MatchedDeclaration", () => {
    const patterns = [
      typedPattern("a {x:int}", "steps/widgets.ts", 3, 15),
      typedPattern("an {x:int}", "steps/widgets.ts", 3, 15),
    ];

    const matched = matchStepText("a 3", patterns);

    expect(matched).toHaveLength(1);
    expect(matched[0]).toEqual({
      declarationFile: "steps/widgets.ts",
      declarationPosition: { row: 3, column: 15 },
    });
  });

  it("reports two MatchedDeclarations when two different declarations both match (ambiguous)", () => {
    const patterns = [
      typedPattern("a {x:int} widgets", "steps/a.ts", 3, 15),
      typedPattern("a {x:int} widgets", "steps/b.ts", 8, 0),
    ];

    const matched = matchStepText("a 3 widgets", patterns);

    expect(matched).toHaveLength(2);
    expect(matched).toEqual(
      expect.arrayContaining([
        { declarationFile: "steps/a.ts", declarationPosition: { row: 3, column: 15 } },
        { declarationFile: "steps/b.ts", declarationPosition: { row: 8, column: 0 } },
      ]),
    );
  });

  it("returns an empty array when nothing matches", () => {
    const patterns = [typedPattern("a {x:int} widgets", "steps/a.ts", 3, 15)];

    expect(matchStepText("completely unrelated text", patterns)).toEqual([]);
  });

  it("matches a compat regexp pattern too, deduplicating the same way", () => {
    const patterns: ExtractedPattern[] = [
      {
        declarationFile: "steps/compat.ts",
        declarationPosition: { row: 1, column: 0 },
        kind: "compat",
        pattern: /^a (\d+) widgets$/,
      },
    ];

    expect(matchStepText("a 3 widgets", patterns)).toHaveLength(1);
    expect(matchStepText("no match here", patterns)).toEqual([]);
  });

  it("skips a pattern resolveStaticPattern cannot resolve, without throwing", () => {
    const patterns: ExtractedPattern[] = [
      typedPattern("a {undefinedType:notARealType}", "steps/broken.ts", 0, 0),
    ];

    expect(matchStepText("anything", patterns)).toEqual([]);
  });
});
