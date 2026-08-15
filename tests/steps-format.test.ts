import { describe, expect, it } from "vitest";
import { formatVocabulary, type StepSummary } from "../src/cli/vocabulary.js";

// Responsibility: unit tests for
// formatVocabulary — the pure function `nuka steps`' non-JSON output goes
// through. Exercises it directly (no CLI/yargs/process.stdout involved) so
// width is explicit and every case is deterministic.

describe("formatVocabulary", () => {
  it("renders a typed entry as heading + pattern + description", () => {
    const summaries: StepSummary[] = [
      {
        name: "add-todo",
        kind: "typed",
        patterns: ["a todo titled {title:string} is added"],
        description: "Create a todo via POST /todos and return the created record",
        mutates: true,
      },
    ];

    expect(formatVocabulary(summaries, 80)).toBe(
      "add-todo  typed  mutates\n" +
        "  a todo titled {title:string} is added\n" +
        "  Create a todo via POST /todos and return the created record\n",
    );
  });

  it("omits the description line for a typed entry with no description", () => {
    const summaries: StepSummary[] = [
      {
        name: "read-only-step",
        kind: "typed",
        patterns: ["a pattern"],
        mutates: false,
      },
    ];

    expect(formatVocabulary(summaries, 80)).toBe(
      "read-only-step  typed  read-only\n  a pattern\n",
    );
  });

  it("renders a compat entry as a heading-only line, no pattern line", () => {
    const summaries: StepSummary[] = [
      {
        name: "compat: a legacy project {string} exists",
        kind: "compat",
        patterns: ["a legacy project {string} exists"],
      },
    ];

    expect(formatVocabulary(summaries, 80)).toBe(
      "compat: a legacy project {string} exists  compat\n",
    );
  });

  it("renders one line per pattern for a typed entry with multiple patterns", () => {
    const summaries: StepSummary[] = [
      {
        name: "multi",
        kind: "typed",
        patterns: ["pattern one", "pattern two"],
        mutates: true,
      },
    ];

    expect(formatVocabulary(summaries, 80)).toBe(
      "multi  typed  mutates\n  pattern one\n  pattern two\n",
    );
  });

  it("wraps a description wider than the given width, continuation lines indented 4", () => {
    const summaries: StepSummary[] = [
      {
        name: "n",
        kind: "typed",
        patterns: ["p"],
        mutates: true,
        description: "one two three four five",
      },
    ];

    // At width 20: "  one two three four" is exactly 20 chars (fits);
    // adding " five" would push it to 25, so it wraps there, continuing at
    // indent 4.
    expect(formatVocabulary(summaries, 20)).toBe(
      "n  typed  mutates\n  p\n  one two three four\n    five\n",
    );
  });

  it("does not split a single word wider than the given width", () => {
    const longWord = "a".repeat(50);
    const summaries: StepSummary[] = [
      {
        name: "n",
        kind: "typed",
        patterns: ["p"],
        mutates: true,
        description: longWord,
      },
    ];

    const output = formatVocabulary(summaries, 10);
    const lines = output.split("\n");
    // heading, pattern, the unsplit long word, then the trailing "" from
    // the final "\n".
    expect(lines).toEqual(["n  typed  mutates", "  p", `  ${longWord}`, ""]);
  });

  it("uses the (no pattern) placeholder for a typed entry with no patterns", () => {
    const summaries: StepSummary[] = [
      {
        name: "no-pattern-step",
        kind: "typed",
        patterns: [],
        mutates: true,
      },
    ];

    expect(formatVocabulary(summaries, 80)).toBe(
      "no-pattern-step  typed  mutates\n  (no pattern)\n",
    );
  });

  it("separates multiple blocks with exactly one blank line and no trailing blank line", () => {
    const summaries: StepSummary[] = [
      { name: "first", kind: "typed", patterns: ["p1"], mutates: true },
      { name: "second", kind: "typed", patterns: ["p2"], mutates: false },
    ];

    expect(formatVocabulary(summaries, 80)).toBe(
      "first  typed  mutates\n  p1\n\nsecond  typed  read-only\n  p2\n",
    );
  });

  it("returns an empty string for an empty vocabulary", () => {
    expect(formatVocabulary([], 80)).toBe("");
  });

  it("appends a 'browser' marker to the heading when needs_browser is true", () => {
    const summaries: StepSummary[] = [
      {
        name: "opens-a-tab",
        kind: "typed",
        patterns: ["p"],
        mutates: true,
        needs: ["context"],
        needs_browser: true,
      },
    ];
    expect(formatVocabulary(summaries, 80)).toBe("opens-a-tab  typed  mutates  browser\n  p\n");
  });

  it("adds no marker, and never lists needs, when needs_browser is false", () => {
    const summaries: StepSummary[] = [
      {
        name: "api-only",
        kind: "typed",
        patterns: ["p"],
        mutates: true,
        needs: ["request"],
        needs_browser: false,
      },
    ];
    expect(formatVocabulary(summaries, 80)).toBe("api-only  typed  mutates\n  p\n");
  });
});
