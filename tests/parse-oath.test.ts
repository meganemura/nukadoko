import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { StepKeywordType } from "@cucumber/messages";
import { parseOathSource, parseTableRow, splitSentences } from "../src/feature/parse-oath.js";

// Responsibility: the Markdown oath parser is a pure function from text to
// pickles. The properties pin the two splits a hand-written example would
// under-specify (sentence boundaries, and table cells), and the examples
// pin the decisions the rest of the pipeline depends on: keywords are not
// part of the matched text, a Markdown header is not a data row, and
// `<column>` placeholders turn a table into Examples.

const word = gs.text({ alphabet: "abc", minSize: 1, maxSize: 12 });

describe("splitSentences", () => {
  it("splits on a period that stands between two sentences", () =>
    hegel.test((tc) => {
      const a = tc.draw(word);
      const b = tc.draw(word);
      expect(splitSentences(`${a}. ${b}`)).toEqual([a, b]);
    }));

  it("does not split on a period inside double quotes", () =>
    hegel.test((tc) => {
      const left = tc.draw(gs.text({ alphabet: "abc", minSize: 0, maxSize: 8 }));
      const inner = tc.draw(gs.text({ alphabet: "abc.!", minSize: 0, maxSize: 8 }));
      const right = tc.draw(gs.text({ alphabet: "abc", minSize: 0, maxSize: 8 }));
      const line = `${left}"${inner}"${right}`;
      expect(splitSentences(line)).toEqual([line]);
    }));
});

describe("parseTableRow", () => {
  it("returns the cells of a pipe row", () =>
    hegel.test((tc) => {
      const cells = tc.draw(
        gs.arrays(gs.text({ alphabet: "abc", minSize: 0, maxSize: 6 }), { minSize: 1, maxSize: 4 }),
      );
      expect(parseTableRow(`| ${cells.join(" | ")} |`)).toEqual(cells);
    }));

  it("returns undefined for a line that does not start with a pipe", () => {
    expect(parseTableRow("not a table")).toBeUndefined();
  });
});

describe("parseOathSource", () => {
  it("keeps the same step texts when blank lines surround a scenario break", () =>
    hegel.test((tc) => {
      const count = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
      const words: string[] = [];
      for (let i = 0; i < count; i += 1) {
        words.push(tc.draw(word));
      }
      const lines = words.map((value) => `Given ${value} happened.`);
      const tight = parseOathSource(lines.join("\n---\n"), "oath.md");
      const loose = parseOathSource(lines.join("\n\n---\n\n"), "oath.md");
      const texts = (source: typeof tight) => source.pickles.flatMap((pickle) => pickle.steps.map((step) => step.text));
      expect(texts(tight)).toEqual(words.map((value) => `${value} happened`));
      expect(texts(loose)).toEqual(texts(tight));
    }));

  it("strips a keyword and keeps And as a conjunction", () => {
    const { gherkinDocument } = parseOathSource(
      ["# List", "Given the list includes \"milk\".", "Then the list includes \"milk\".", "And the list includes \"bread\"."].join(
        "\n",
      ),
      "list.md",
    );
    const steps = gherkinDocument.feature?.children[0]?.scenario?.steps ?? [];
    expect(steps.map((step) => step.text)).toEqual([
      'the list includes "milk"',
      'the list includes "milk"',
      'the list includes "bread"',
    ]);
    expect(steps.map((step) => step.keywordType)).toEqual([
      StepKeywordType.CONTEXT,
      StepKeywordType.OUTCOME,
      StepKeywordType.CONJUNCTION,
    ]);
  });

  it("omits a Markdown header from a data table", () => {
    const { gherkinDocument } = parseOathSource(
      ["Given the following todos are added.", "", "| title |", "| --- |", "| Water the plants |", "| Read a book |"].join("\n"),
      "todos.md",
    );
    const table = gherkinDocument.feature?.children[0]?.scenario?.steps[0]?.dataTable;
    expect(table?.rows.map((row) => row.cells.map((cell) => cell.value))).toEqual([
      ["Water the plants"],
      ["Read a book"],
    ]);
  });

  it("expands an examples table into one pickle per body row", () => {
    const { pickles } = parseOathSource(
      [
        'Given a todo titled "<title>" is added.',
        'Then the todo list includes "<title>".',
        "",
        "| title |",
        "| --- |",
        "| Buy milk |",
      ].join("\n"),
      "outline.md",
    );
    expect(pickles).toHaveLength(1);
    expect(pickles[0]?.steps.map((step) => step.text)).toEqual([
      'a todo titled "Buy milk" is added',
      'the todo list includes "Buy milk"',
    ]);
  });

  it("does not turn a blockquote into a step", () => {
    const { pickles } = parseOathSource(
      ["> This sentence matches nothing.", 'Given the list includes "milk".'].join("\n"),
      "narration.md",
    );
    expect(pickles).toHaveLength(1);
    expect(pickles[0]?.steps.map((step) => step.text)).toEqual(['the list includes "milk"']);
  });

  it("keeps an unmatched sentence as a step on its own line", () => {
    const { gherkinDocument } = parseOathSource("# List\n\nThe cupboard holds a secret.\n", "drift.md");
    const step = gherkinDocument.feature?.children[0]?.scenario?.steps[0];
    expect(step?.text).toBe("The cupboard holds a secret");
    expect(step?.location.line).toBe(3);
  });
});
