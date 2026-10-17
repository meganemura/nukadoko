import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { EXAMPLES, GAP, fencedBlocks, mismatch, normalizeLine, staticDrift, transcripts } from "../scripts/skill-examples.js";
import { repoRoot } from "./helpers/fixtures.js";

// Responsibility: the acceptance skill's worked examples quote their
// projects' files as they are, and the transcript matcher that
// `npm run skill-examples` replays them with reads `...` and durations the
// way the Markdown means them.

describe("the acceptance skill's worked examples", () => {
  for (const example of EXAMPLES) {
    it(`${example.markdown} quotes ${example.project} as it is`, () => {
      expect(staticDrift(repoRoot, example)).toEqual([]);
    });
  }
});

describe("scripts/skill-examples.ts", () => {
  it("reads a transcript block into commands and their output lines, and skips a labelled block", () => {
    const markdown = [
      "```",
      "$ npx nuka check",
      "ok: no issues found",
      "$ npx nuka run",
      "...",
      "4 scenarios: 4 passed, 0 failed  (2s)",
      "```",
      "```ts",
      "$ not a transcript",
      "```",
    ].join("\n");
    expect(transcripts(markdown)).toEqual([
      { command: "npx nuka check", expected: ["ok: no issues found"] },
      { command: "npx nuka run", expected: ["...", "4 scenarios: 4 passed, 0 failed  (2s)"] },
    ]);
    expect(fencedBlocks(markdown).map((block) => [block.info, block.line])).toEqual([
      ["", 1],
      ["ts", 8],
    ]);
  });

  it("masks durations and cuts a finding after its file", () => {
    expect(normalizeLine("  step 2/4  ok  0.1s  I run tally")).toBe("  step 2/4  ok  N.Ns  I run tally");
    expect(normalizeLine("4 scenarios: 4 passed, 0 failed  (12s)")).toBe("4 scenarios: 4 passed, 0 failed  (Ns)");
    expect(normalizeLine("note\trepeated-scenario-prefix\tfeatures/a.feature\t2 scenarios took 0 seconds")).toBe(
      "note\trepeated-scenario-prefix\tfeatures/a.feature",
    );
  });

  it("names the first expected line that does not match", () => {
    expect(mismatch(["a", "...", "c"], ["a", "b", "c"])).toBeNull();
    expect(mismatch(["a", "c"], ["a", "b", "c"])).toBe('no line matches "c"');
    expect(mismatch(["a"], ["a", "b"])).toBe("output has more lines");
    expect(mismatch(["8 scenarios: 8 passed, 0 failed  (1s)"], ["7 scenarios: 7 passed, 0 failed  (3s)"])).toBe(
      'no line matches "8 scenarios: 8 passed, 0 failed  (1s)"',
    );
  });

  const line = gs.text({ maxSize: 8, alphabet: "ab ." });

  it("output matches itself, and still matches with any run of its lines replaced by ...", () =>
    hegel.test((tc) => {
      const actual = tc.draw(gs.arrays(line, { maxSize: 8 })).filter((text) => text !== GAP);
      const start = tc.draw(gs.integers({ minValue: 0, maxValue: actual.length }));
      const end = tc.draw(gs.integers({ minValue: start, maxValue: actual.length }));
      expect(mismatch(actual, actual)).toBeNull();
      expect(mismatch([...actual.slice(0, start), GAP, ...actual.slice(end)], actual)).toBeNull();
    }));

  it("output with one line added never matches the expected lines without a ...", () =>
    hegel.test((tc) => {
      const actual = tc.draw(gs.arrays(line, { maxSize: 8 })).filter((text) => text !== GAP);
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: actual.length }));
      const longer = [...actual.slice(0, at), tc.draw(line), ...actual.slice(at)];
      expect(mismatch(actual, longer)).not.toBeNull();
    }));
});
