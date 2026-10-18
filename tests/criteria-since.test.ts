import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { parseFeatureSource } from "../src/feature/load-features.js";
import { classifyCriteria, criteriaAtRef, criteriaOf } from "../src/run/criteria-since.js";

// Responsibility: the --since classifier, pure. A scenario's criteria are
// its Gherkin lines, so a feature written out again with other indentation,
// blank lines, and comments has every scenario unchanged; editing one
// step changes that scenario and no other; a scenario the ref lacks is
// new; and an Examples row is found by its values.

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
  // by occurrence and have their own example below.
  .map((list) => list.map(([steps, rows], index): ScenarioSpec => ({ name: `scenario ${index}`, steps, rows: [...new Set(rows)] })));
const style = gs.tuples(gs.integers({ minValue: 1, maxValue: 6 }), gs.booleans(), gs.booleans()).map(([indent, blank, comment]): Style => ({ indent, blank, comment }));

/** Each pickle of `now`'s scenarios, classified against `before`. */
function classifyAll(before: string | undefined, now: string): { name: string; change: string }[] {
  const atRef = criteriaAtRef(before, "features/shop.feature");
  const { gherkinDocument, pickles } = parseFeatureSource(now, "features/shop.feature");
  return pickles.map((pickle) => {
    const criteria = criteriaOf(gherkinDocument, pickle)!;
    return { name: pickle.name, change: classifyCriteria(atRef.get(criteria.key), criteria.lines) };
  });
}

describe("classifyCriteria", () => {
  it("is unchanged for equal lines, new without lines at the ref, and changed for any other pair", () =>
    hegel.test((tc) => {
      const before = tc.draw(gs.arrays(gs.text({ maxSize: 8 }), { maxSize: 4 }));
      const after = tc.draw(gs.arrays(gs.text({ maxSize: 8 }), { maxSize: 4 }));
      expect(classifyCriteria(before, [...before])).toBe("unchanged");
      expect(classifyCriteria(undefined, after)).toBe("new");
      const same = before.length === after.length && before.every((line, index) => line === after[index]);
      expect(classifyCriteria(before, after)).toBe(same ? "unchanged" : "changed");
    }));
});

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

  it("treats every scenario as new when the ref holds no such file, or one that does not parse", () => {
    const now = render([], [{ name: "only", steps: ["a cart with a price"], rows: [] }], { indent: 2, blank: false, comment: false });
    expect(classifyAll(undefined, now)).toEqual([{ name: "only", change: "new" }]);
    expect(classifyAll("Feature: x\n  Scenario: y\n    Given\n  | broken", now)).toEqual([{ name: "only", change: "new" }]);
  });

  it("finds an Examples row by its values, so a row whose value changed is new and the others stay unchanged", () => {
    const plain = { indent: 2, blank: false, comment: false };
    const before = render([], [{ name: "rows", steps: ["a cart with"], rows: ["1", "2"] }], plain);
    const after = render([], [{ name: "rows", steps: ["a cart with"], rows: ["1", "5"] }], plain);
    expect(classifyAll(before, after)).toEqual([
      { name: "rows", change: "unchanged" },
      { name: "rows", change: "new" },
    ]);
  });

  it("matches two scenarios of one name by which one they are", () => {
    const plain = { indent: 2, blank: false, comment: false };
    const before = render([], [{ name: "same", steps: ["a cart with a price"], rows: [] }, { name: "same", steps: ["a user with a coupon"], rows: [] }], plain);
    const after = render([], [{ name: "same", steps: ["a cart with a price"], rows: [] }, { name: "same", steps: ["a user with a total"], rows: [] }], plain);
    expect(classifyAll(before, after)).toEqual([
      { name: "same", change: "unchanged" },
      { name: "same", change: "changed" },
    ]);
  });

  it("counts a docstring and a data table as part of the step", () => {
    const base = 'Feature: Shop\n\n  Scenario: with arguments\n    Given a note\n      """\n      first\n      """\n    And a table\n      | a | b |\n';
    const atRef = criteriaAtRef(base, "f.feature");
    const now = parseFeatureSource(base.replace("first", "second"), "f.feature");
    const criteria = criteriaOf(now.gherkinDocument, now.pickles[0]!)!;
    expect(criteria.lines).toEqual(["Given a note", '"""', "second", '"""', "And a table", "| a | b |"]);
    expect(classifyCriteria(atRef.get(criteria.key), criteria.lines)).toBe("changed");
  });
});
