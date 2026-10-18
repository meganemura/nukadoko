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
        file: "features/steps/s.ts",
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
        file: "features/steps/s.ts",
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
        file: "features/steps/s.ts",
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
        file: "features/steps/s.ts",
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
        file: "features/steps/s.ts",
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
        file: "features/steps/s.ts",
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
        file: "features/steps/s.ts",
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
      { name: "first", kind: "typed", file: "features/steps/s.ts", patterns: ["p1"], mutates: true },
      { name: "second", kind: "typed", file: "features/steps/s.ts", patterns: ["p2"], mutates: false },
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
        file: "features/steps/s.ts",
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
        file: "features/steps/s.ts",
        patterns: ["p"],
        mutates: true,
        needs: ["request"],
        needs_browser: false,
      },
    ];
    expect(formatVocabulary(summaries, 80)).toBe("api-only  typed  mutates\n  p\n");
  });
});

describe("nuka steps text", () => {
  it("wraps at 80 columns whatever width the terminal reports", async () => {
    const { runCli } = await import("../src/cli/run-cli.js");
    const { createCaptureSink, fixture } = await import("./helpers/fixtures.js");
    const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: 20, configurable: true });
    try {
      const stdout = createCaptureSink();
      await runCli(["steps"], { rootDir: fixture("basic-project"), stdout, stderr: createCaptureSink() });
      expect(stdout.text()).toContain("  the project {string} can be looked up by id\n");
    } finally {
      if (columns === undefined) delete (process.stdout as { columns?: number }).columns;
      else Object.defineProperty(process.stdout, "columns", columns);
    }
  });
});
