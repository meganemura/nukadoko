import { describe, expect, it } from "vitest";
import { buildCompletionCandidates } from "../../src/index/completion-candidates.js";
import { matchStepText, type ExtractedPattern } from "../../src/extraction/index.js";

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

  it("inserts a snippet with a quoted tab stop for a string capture", () => {
    const [candidate] = buildCompletionCandidates([
      typedPattern("a todo titled {title:string} is added", "steps/todo.ts"),
    ]);

    expect(candidate?.snippet).toBe('a todo titled "${1:title}" is added');
  });

  it("numbers one tab stop per parameter, in pattern order", () => {
    const [candidate] = buildCompletionCandidates([compatPattern("{int} items cost {float} in {word}", "steps/c.ts")]);

    expect(candidate?.snippet).toBe("${1:1} items cost ${2:1.5} in ${3:word}");
  });

  it("drops optional text, keeps the first alternative, and escapes snippet syntax", () => {
    const [candidate] = buildCompletionCandidates([
      compatPattern("I have {int} cucumber(s) in my belly/stomach for $5 \\{ok\\}", "steps/c.ts"),
    ]);

    expect(candidate?.snippet).toBe("I have ${1:1} cucumber in my belly for \\$5 {ok\\}");
  });
});

// The text a user gets by pressing Tab through every stop without typing.
function expandDefaults(snippet: string): string {
  return snippet.replace(/\$\{\d+:((?:\\.|[^\\}])*)\}|\\(.)/g, (_match, placeholder?: string, escaped?: string) =>
    placeholder !== undefined ? placeholder.replace(/\\(.)/g, "$1") : (escaped ?? ""),
  );
}

describe("a completion's default expansion binds to its own declaration", () => {
  const patterns: readonly ExtractedPattern[] = [
    typedPattern("a todo titled {title:string} is added", "steps/typed.ts"),
    typedPattern("{count:int} widgets weigh {weight:float} kg", "steps/typed.ts"),
    typedPattern("user {name:word} writes {note:}", "steps/typed.ts"),
    typedPattern("{a:double} {b:bigdecimal} {c:byte} {d:short} {e:long} {f:biginteger}", "steps/typed.ts"),
    compatPattern("a {int} widgets", "steps/compat.ts"),
    compatPattern("{string} is shown", "steps/compat.ts"),
    compatPattern("anything {} goes", "steps/compat.ts"),
    compatPattern("I have {int} cucumber(s) in my belly/stomach", "steps/compat.ts"),
    compatPattern("a literal \\{brace\\} and \\(paren\\) and a\\/b {word}", "steps/compat.ts"),
    compatPattern("it costs $5 {int} times", "steps/compat.ts"),
  ];

  for (const pattern of patterns) {
    it(`${String(pattern.pattern)}`, () => {
      const [candidate] = buildCompletionCandidates([pattern]);
      const expanded = expandDefaults(candidate?.snippet ?? "");

      expect(matchStepText(expanded, [pattern])).toEqual([
        { declarationFile: pattern.declarationFile, declarationPosition: pattern.declarationPosition },
      ]);
    });
  }
});
