import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { parseFeatureSource } from "../src/feature/load-features.js";
import { criteriaOfDocument, matchCriteria, type Criterion } from "../src/run/criteria-since.js";

// Responsibility: the --since classifier, pure. A scenario's criteria are
// what decides how it runs, so a feature written out again with other
// indentation, blank lines, and comments has every scenario unchanged;
// editing one step changes that scenario and no other; a scenario the ref
// lacks is new and one the working tree lacks is removed; tags and the
// effective keyword count and a docstring's delimiter does not; and a
// repeated name is matched by content, or reported ambiguous.

interface ScenarioSpec {
  readonly name: string;
  readonly steps: readonly string[];
  /** Examples rows of one `n` column; empty for a plain scenario. */
  readonly rows: readonly string[];
}

interface Style {
  readonly indent: number;
  readonly blank: boolean;
  readonly comment: boolean;
}

function render(background: readonly string[], scenarios: readonly ScenarioSpec[], style: Style): string {
  const pad = " ".repeat(style.indent);
  const out = ["Feature: Shop", ""];
  if (style.comment) out.push(`${pad}# a comment that is no criterion`);
  if (background.length > 0) {
    out.push(`${pad}Background:`, ...background.map((text) => `${pad}${pad}Given ${text}`), "");
  }
  for (const scenario of scenarios) {
    if (style.blank) out.push("");
    out.push(`${pad}${scenario.rows.length > 0 ? "Scenario Outline" : "Scenario"}: ${scenario.name}`);
    scenario.steps.forEach((text, index) => out.push(`${pad}${pad}${index === 0 ? "Given" : "Then"} ${scenario.rows.length > 0 ? `${text} <n>` : text}`));
    if (scenario.rows.length > 0) {
      out.push("", `${pad}${pad}Examples:`, `${pad}${pad}${pad}| n |`, ...scenario.rows.map((row) => `${pad}${pad}${pad}| ${row} |`));
    }
    out.push("");
  }
  return out.join("\n");
}

const word = gs.sampledFrom(["cart", "item", "price", "total", "coupon", "user"] as const);
const stepText = gs.tuples(word, word).map(([a, b]) => `a ${a} with a ${b}`);
const scenarioSpecs = gs
  .arrays(
    gs.tuples(gs.arrays(stepText, { minSize: 1, maxSize: 3 }), gs.arrays(gs.sampledFrom(["1", "2", "3", "4"] as const), { maxSize: 3 })),
    { minSize: 1, maxSize: 5 },
  )
  // Unique names keep the expectation simple; duplicate names are matched
  // by content and have their own tests below.
  .map((list) => list.map(([steps, rows], index): ScenarioSpec => ({ name: `scenario ${index}`, steps, rows: [...new Set(rows)] })));
const style = gs.tuples(gs.integers({ minValue: 1, maxValue: 6 }), gs.booleans(), gs.booleans()).map(([indent, blank, comment]): Style => ({ indent, blank, comment }));

function criteria(source: string): Criterion[] {
  const { gherkinDocument, pickles } = parseFeatureSource(source, "features/shop.feature");
  return criteriaOfDocument(gherkinDocument, pickles);
}

/** Each pickle of `now`'s scenarios, classified against `before`. */
function classifyAll(before: string | undefined, now: string): { name: string; change: string }[] {
  const nowCriteria = criteria(now);
  const { verdicts } = matchCriteria(before === undefined ? null : criteria(before), nowCriteria);
  return nowCriteria.map((criterion) => ({ name: criterion.name, change: verdicts.get(criterion.line)!.change }));
}

function removedNames(before: string, now: string): string[] {
  return matchCriteria(criteria(before), criteria(now)).removed.map((criterion) => criterion.name);
}

describe("criteria of a feature at a ref", () => {
  it("leaves every scenario unchanged when only indentation, blank lines, and comments differ", () =>
    hegel.test((tc) => {
      const background = tc.draw(gs.arrays(stepText, { maxSize: 2 }));
      const scenarios = tc.draw(scenarioSpecs);
      const results = classifyAll(render(background, scenarios, tc.draw(style)), render(background, scenarios, tc.draw(style)));
      expect(results.every((result) => result.change === "unchanged")).toBe(true);
    }));

  it("changes exactly the scenario whose step changed, every row of it", () =>
    hegel.test((tc) => {
      const scenarios = tc.draw(scenarioSpecs);
      const target = tc.draw(gs.integers({ minValue: 0, maxValue: scenarios.length - 1 }));
      const edited = scenarios.map((scenario, index) => (index === target ? { ...scenario, steps: [...scenario.steps, "a step added later"] } : scenario));
      const results = classifyAll(render([], scenarios, { indent: 2, blank: false, comment: false }), render([], edited, { indent: 2, blank: false, comment: false }));
      for (const result of results) expect(result.change).toBe(result.name === `scenario ${target}` ? "changed" : "unchanged");
    }));

  it("changes every scenario when a Background step changes", () =>
    hegel.test((tc) => {
      const scenarios = tc.draw(scenarioSpecs);
      const plain = { indent: 2, blank: false, comment: false };
      const results = classifyAll(render(["a shop is open"], scenarios, plain), render(["a shop is closed"], scenarios, plain));
      expect(results.every((result) => result.change === "changed")).toBe(true);
    }));

  it("makes a scenario the ref lacks new, and leaves the others unchanged", () =>
    hegel.test((tc) => {
      const scenarios = tc.draw(scenarioSpecs);
      const dropped = tc.draw(gs.integers({ minValue: 0, maxValue: scenarios.length - 1 }));
      const plain = { indent: 2, blank: false, comment: false };
      const results = classifyAll(render([], scenarios.filter((_, index) => index !== dropped), plain), render([], scenarios, plain));
      for (const result of results) expect(result.change).toBe(result.name === `scenario ${dropped}` ? "new" : "unchanged");
    }));

  it("treats every scenario as new when the ref holds no such file", () => {
    const now = render([], [{ name: "only", steps: ["a cart with a price"], rows: [] }], { indent: 2, blank: false, comment: false });
    expect(classifyAll(undefined, now)).toEqual([{ name: "only", change: "new" }]);
  });

  it("finds an Examples row by its values, so a row whose value changed is new and the row it replaced is removed", () => {
    const plain = { indent: 2, blank: false, comment: false };
    const before = render([], [{ name: "rows", steps: ["a cart with"], rows: ["1", "2"] }], plain);
    const after = render([], [{ name: "rows", steps: ["a cart with"], rows: ["1", "5"] }], plain);
    expect(classifyAll(before, after)).toEqual([
      { name: "rows", change: "unchanged" },
      { name: "rows", change: "new" },
    ]);
    expect(matchCriteria(criteria(before), criteria(after)).removed.map((criterion) => criterion.lines.at(-1))).toEqual(["| 2 |"]);
  });

  it("removes exactly the scenarios the working tree no longer holds, and leaves every kept one unchanged", () =>
    hegel.test((tc) => {
      const scenarios = tc.draw(scenarioSpecs);
      const kept = tc.draw(gs.arrays(gs.booleans(), { minSize: scenarios.length, maxSize: scenarios.length }));
      const plain = { indent: 2, blank: false, comment: false };
      const after = scenarios.filter((_, index) => kept[index]);
      const expected = scenarios
        .filter((_, index) => !kept[index])
        .flatMap((scenario) => Array<string>(Math.max(1, scenario.rows.length)).fill(scenario.name));
      expect(removedNames(render([], scenarios, plain), render([], after, plain))).toEqual(expected);
      expect(classifyAll(render([], scenarios, plain), render([], after, plain)).every((result) => result.change === "unchanged")).toBe(true);
    }));

  it("matches scenarios of one name by content, wherever they moved", () =>
    hegel.test((tc) => {
      const drawn = tc.draw(scenarioSpecs);
      // Distinct content, so content alone pairs each one.
      const distinct = drawn.map((scenario, index): ScenarioSpec => ({ name: "same", steps: [...scenario.steps, `step number ${index}`], rows: [] }));
      const keys = distinct.map(() => tc.draw(gs.integers({ minValue: 0, maxValue: 1000 })));
      const moved = distinct.map((scenario, index) => ({ scenario, key: keys[index]! })).sort((a, b) => a.key - b.key).map((entry) => entry.scenario);
      const plain = { indent: 2, blank: false, comment: false };
      expect(classifyAll(render([], distinct, plain), render([], moved, plain)).every((result) => result.change === "unchanged")).toBe(true);
    }));

  it("pairs the one edited scenario of a repeated name, and reports two edited ones as ambiguous", () => {
    const plain = { indent: 2, blank: false, comment: false };
    const spec = (steps: string[]): ScenarioSpec => ({ name: "same", steps, rows: [] });
    const before = render([], [spec(["a cart with a price"]), spec(["a user with a coupon"])], plain);
    const oneEdited = render([], [spec(["a user with a total"]), spec(["a cart with a price"])], plain);
    expect(classifyAll(before, oneEdited)).toEqual([
      { name: "same", change: "changed" },
      { name: "same", change: "unchanged" },
    ]);
    const bothEdited = render([], [spec(["a user with a total"]), spec(["a cart with a coupon"])], plain);
    const { verdicts, removed } = matchCriteria(criteria(before), criteria(bothEdited));
    const reason = '2 scenarios named "same" at the ref and 2 now differ in content, so which one changed cannot be told';
    expect([...verdicts.values()]).toEqual([
      { change: "ambiguous", reason },
      { change: "ambiguous", reason },
    ]);
    expect(removed).toEqual([]);
  });

  it("counts a Feature, Rule, Scenario, or Examples tag, so adding one changes the scenario", () => {
    const base = "Feature: Shop\n\n  Rule: r\n\n    Scenario Outline: tagged\n      Given a cart with <n>\n\n      Examples:\n        | n |\n        | 1 |\n";
    const tagged = [
      base.replace("Feature: Shop", "@slow\nFeature: Shop"),
      base.replace("  Rule: r", "  @slow\n  Rule: r"),
      base.replace("    Scenario Outline", "    @slow\n    Scenario Outline"),
      base.replace("      Examples:", "      @slow\n      Examples:"),
    ];
    for (const now of tagged) {
      expect(classifyAll(base, now)).toEqual([{ name: "tagged", change: "changed" }]);
      expect(criteria(now)[0]!.lines).toEqual(["@slow", "Given a cart with <n>", "| n |", "| 1 |"]);
    }
  });

  it("reads And and But as the keyword they continue, so only a change of that keyword counts", () => {
    const of = (second: string) => `Feature: Shop\n\n  Scenario: keyed\n    Given a cart\n    ${second} an item\n`;
    expect(classifyAll(of("Given"), of("And"))).toEqual([{ name: "keyed", change: "unchanged" }]);
    expect(classifyAll(of("And"), of("But"))).toEqual([{ name: "keyed", change: "unchanged" }]);
    expect(classifyAll(of("And"), of("When"))).toEqual([{ name: "keyed", change: "changed" }]);
  });

  it("does not count a docstring's delimiter, and counts its media type", () => {
    const of = (open: string, close: string) => `Feature: Shop\n\n  Scenario: doc\n    Given a note\n      ${open}\n      body\n      ${close}\n`;
    expect(classifyAll(of('"""', '"""'), of("```", "```"))).toEqual([{ name: "doc", change: "unchanged" }]);
    expect(classifyAll(of('"""', '"""'), of('"""json', '"""'))).toEqual([{ name: "doc", change: "changed" }]);
    expect(criteria(of('"""json', '"""'))[0]!.lines).toEqual(["Given a note", '"""json', "body", '"""']);
  });

  it("tells a cell that holds a pipe from two cells", () => {
    const of = (row: string) => `Feature: Shop\n\n  Scenario: table\n    Given a table\n      ${row}\n`;
    expect(classifyAll(of("| a \\| b |"), of("| a | b |"))).toEqual([{ name: "table", change: "changed" }]);
    expect(criteria(of("| a \\| b |"))[0]!.lines).toEqual(["Given a table", "| a \\| b |"]);
  });

  it("counts a docstring and a data table as part of the step", () => {
    const base = 'Feature: Shop\n\n  Scenario: with arguments\n    Given a note\n      """\n      first\n      """\n    And a table\n      | a | b |\n';
    expect(criteria(base.replace("first", "second"))[0]!.lines).toEqual(["Given a note", '"""', "second", '"""', "And a table", "| a | b |"]);
    expect(classifyAll(base, base.replace("first", "second"))).toEqual([{ name: "with arguments", change: "changed" }]);
    expect(classifyAll(base, base.replace("| a | b |", "| a | c |"))).toEqual([{ name: "with arguments", change: "changed" }]);
  });

  it("builds the criteria of a 3000-row outline once, not once per row", () => {
    const rows = Array.from({ length: 3000 }, (_, index) => `      | ${index} |`).join("\n");
    const source = `Feature: Shop\n\n  Scenario Outline: many\n    Given a cart with <n>\n\n    Examples:\n      | n |\n${rows}\n`;
    const started = performance.now();
    const { verdicts } = matchCriteria(criteria(source), criteria(source));
    // Once per row measured 5.2 s here; once per document is well under 1 s.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(verdicts.size).toBe(3000);
  });
});
