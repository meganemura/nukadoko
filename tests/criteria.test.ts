import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { compareCriteria, criteriaOfFeature, criterionKey, type Criterion } from "../src/run/criteria.js";
import { parseFeatureSource } from "../src/feature/load-features.js";

// Responsibility: what one criterion is to `nuka run --base`
// (src/run/criteria.ts). A rename, a move, a tag that is not a condition,
// or an And spelled as the keyword it continues never changes a
// criterion; any change to a sentence, a table, a docstring, an Examples
// row, or a condition tag does. The tests write real feature source and
// read it through the parser `nuka run` uses, so what is compared is what a
// person edits.

interface Step {
  readonly keyword: "Given" | "When" | "Then" | "And";
  readonly text: string;
  readonly docString: string | null;
  readonly table: readonly (readonly string[])[] | null;
}

interface Spec {
  readonly name: string;
  readonly padding: number;
  readonly otherTags: readonly string[];
  readonly conditionTags: readonly string[];
  readonly steps: readonly Step[];
  /** An outline with one Examples row, `n` its one column. */
  readonly example: string | null;
}

const word = gs.sampledFrom(["cart", "total", "item", "price", "list"]);
const firstKeyword = gs.sampledFrom(["Given", "When", "Then"] as const);
const anyKeyword = gs.sampledFrom(["Given", "When", "Then", "And"] as const);
const cellValue = gs.sampledFrom(["a", "b", "1", "2", "x|y"]);
const step = (keyword: typeof anyKeyword) =>
  gs.tuples(keyword, gs.arrays(word, { minSize: 1, maxSize: 3 }), gs.optional(gs.sampledFrom(["one", "two lines\nof text"])), gs.optional(gs.arrays(gs.arrays(cellValue, { minSize: 2, maxSize: 2 }), { minSize: 1, maxSize: 2 }))).map(
    ([kw, words, docString, table]): Step => ({ keyword: kw, text: words.join(" "), docString, table }),
  );
const spec = gs
  .tuples(
    gs.sampledFrom(["an empty cart", "three items", "the total"]),
    gs.integers({ minValue: 0, maxValue: 3 }),
    gs.arrays(gs.sampledFrom(["@smoke", "@slow", "@wip"]), { maxSize: 2 }),
    gs.arrays(gs.sampledFrom(["@with:banner", "@without:cache", "@with:mode=dark", "@held"]), { maxSize: 2 }),
    step(firstKeyword),
    gs.arrays(step(anyKeyword), { maxSize: 3 }),
    gs.optional(gs.sampledFrom(["1", "2", "many"])),
  )
  .map(([name, padding, otherTags, conditionTags, first, rest, example]): Spec => ({
    name,
    padding,
    otherTags: [...new Set(otherTags)],
    conditionTags: [...new Set(conditionTags)],
    steps: [first, ...rest].map((entry) => (example === null ? entry : { ...entry, text: `${entry.text} <n>` })),
    example,
  }));

function source(feature: Spec): string {
  const lines = ["Feature: cart", ""];
  for (let index = 0; index < feature.padding; index += 1) lines.push(index % 2 === 0 ? "  # a note" : "");
  const tags = [...feature.otherTags, ...feature.conditionTags];
  if (tags.length > 0) lines.push(`  ${tags.join(" ")}`);
  lines.push(`  ${feature.example === null ? "Scenario" : "Scenario Outline"}: ${feature.name}`);
  for (const entry of feature.steps) {
    lines.push(`    ${entry.keyword} ${entry.text}`);
    if (entry.docString !== null) lines.push('      """', ...entry.docString.split("\n").map((text) => `      ${text}`), '      """');
    for (const row of entry.table ?? []) lines.push(`      | ${row.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`);
  }
  if (feature.example !== null) lines.push("", "    Examples:", "      | n |", `      | ${feature.example} |`);
  return `${lines.join("\n")}\n`;
}

function criteriaOf(feature: Spec, path = "features/cart.feature"): Criterion[] {
  const parsed = parseFeatureSource(source(feature), path);
  return criteriaOfFeature(path, parsed.gherkinDocument, parsed.pickles);
}

function only(feature: Spec, path?: string): Criterion {
  const criteria = criteriaOf(feature, path);
  expect(criteria).toHaveLength(1);
  return criteria[0]!;
}

// The keyword an And continues, so spelling it out says the same.
function resolvedKeyword(steps: readonly Step[], index: number): Step["keyword"] {
  for (let at = index; at >= 0; at -= 1) if (steps[at]!.keyword !== "And") return steps[at]!.keyword;
  return "Given";
}

describe("criterion identity", () => {
  it("is the same criterion after a rename, a move, a tag that is not a condition, and an And spelled out", () =>
    hegel.test((tc) => {
      const before = tc.draw(spec);
      const renamed = tc.draw(gs.booleans());
      const spelled = tc.draw(gs.booleans());
      const after: Spec = {
        ...before,
        name: renamed ? `${before.name} again` : before.name,
        padding: tc.draw(gs.integers({ minValue: 0, maxValue: 3 })),
        otherTags: tc.draw(gs.arrays(gs.sampledFrom(["@smoke", "@slow", "@regression"]), { maxSize: 2 })).filter((tag, index, all) => all.indexOf(tag) === index),
        conditionTags: [...before.conditionTags].reverse(),
        steps: spelled ? before.steps.map((entry, index) => ({ ...entry, keyword: resolvedKeyword(before.steps, index) })) : before.steps,
      };
      const base = only(before);
      const head = only(after);
      expect(head.content).toBe(base.content);
      const comparison = compareCriteria([base], [head]);
      expect(comparison.removed).toEqual([]);
      expect(comparison.changes.get(criterionKey(head.feature, head.line))).toEqual({
        change: "unchanged",
        at: { feature: base.feature, line: base.line },
        ...(renamed ? { renamedFrom: { feature: base.feature, name: base.name } } : {}),
      });
    }));

  it("is the same criterion moved to another feature file, renamed from there", () =>
    hegel.test((tc) => {
      const feature = tc.draw(spec);
      const base = only(feature, "features/old.feature");
      const head = only(feature, "features/new.feature");
      expect(compareCriteria([base], [head]).changes.get(criterionKey(head.feature, head.line))).toEqual({
        change: "unchanged",
        at: { feature: "features/old.feature", line: base.line },
        renamedFrom: { feature: "features/old.feature", name: base.name },
      });
    }));

  it("is changed by any edit to a sentence, a keyword, a table, a docstring, an Examples row, or a condition tag", () =>
    hegel.test((tc) => {
      const before = tc.draw(spec);
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: before.steps.length - 1 }));
      const edit = tc.draw(gs.sampledFrom(["sentence", "keyword", "table", "docstring", "example", "condition", "step-added", "step-removed"] as const));
      const steps = [...before.steps];
      const target = steps[at]!;
      let after: Spec = before;
      if (edit === "sentence") steps[at] = { ...target, text: before.example === null ? `${target.text} now` : target.text.replace(" <n>", " now <n>") };
      if (edit === "keyword") {
        const resolved = resolvedKeyword(before.steps, at);
        steps[at] = { ...target, keyword: resolved === "Then" ? "When" : "Then" };
        // The next And continued this keyword; it keeps what it said.
        if (steps[at + 1]?.keyword === "And") steps[at + 1] = { ...steps[at + 1]!, keyword: resolved };
      }
      if (edit === "table") steps[at] = { ...target, table: target.table === null ? [["a", "b"]] : [...target.table.slice(0, -1), [...target.table.at(-1)!.slice(0, -1), `${target.table.at(-1)!.at(-1)}z`]] };
      if (edit === "docstring") steps[at] = { ...target, docString: target.docString === null ? "added" : `${target.docString} more` };
      if (edit === "step-added") steps.splice(at + 1, 0, { keyword: "Then", text: before.example === null ? "one more line" : "one more line <n>", docString: null, table: null });
      // A step more or fewer changes the criterion, whatever keyword the
      // lines around it carry.
      if (edit === "step-removed") {
        if (steps.length === 1) steps.push({ keyword: "Then", text: before.example === null ? "a second line" : "a second line <n>", docString: null, table: null });
        else steps.splice(at, 1);
      }
      after = { ...before, steps };
      if (edit === "example") after = before.example === null ? { ...before, example: "1", steps: steps.map((entry) => ({ ...entry, text: `${entry.text} <n>` })) } : { ...before, example: `${before.example}0` };
      if (edit === "condition") {
        const tag = tc.draw(gs.sampledFrom(["@with:banner", "@without:cache", "@with:mode=dark", "@held"]));
        after = { ...before, conditionTags: before.conditionTags.includes(tag) ? before.conditionTags.filter((entry) => entry !== tag) : [...before.conditionTags, tag] };
      }
      const base = only(before);
      const head = only(after);
      expect(head.content).not.toBe(base.content);
      const comparison = compareCriteria([base], [head]);
      expect(comparison.changes.get(criterionKey(head.feature, head.line))).toEqual({ change: "changed" });
      expect(comparison.removed).toEqual([]);
    }));

  it("is new and removed when both the name and the content changed", () =>
    hegel.test((tc) => {
      const before = tc.draw(spec);
      const after: Spec = { ...before, name: `${before.name} again`, conditionTags: before.conditionTags.includes("@held") ? before.conditionTags.filter((tag) => tag !== "@held") : [...before.conditionTags, "@held"] };
      const base = only(before);
      const head = only(after);
      const comparison = compareCriteria([base], [head]);
      expect(comparison.changes.get(criterionKey(head.feature, head.line))).toEqual({ change: "new" });
      expect(comparison.removed).toEqual([base]);
    }));
});

describe("compareCriteria", () => {
  const criterion = (feature: string, line: number, name: string, content: string): Criterion => ({ feature, line, name, content, tags: [], lines: [] });

  it("pairs a rename within the same file before one in another file", () => {
    const base = [criterion("features/b.feature", 3, "old name", "X"), criterion("features/a.feature", 3, "old name", "X")];
    const comparison = compareCriteria(base, [criterion("features/a.feature", 9, "new name", "X")]);
    expect(comparison.changes.get(criterionKey("features/a.feature", 9))).toEqual({
      change: "unchanged",
      at: { feature: "features/a.feature", line: 3 },
      renamedFrom: { feature: "features/a.feature", name: "old name" },
    });
    expect(comparison.removed).toEqual([base[0]]);
  });

  it("takes no rename when a head criterion in another file claims the same candidate, whichever file is read first", () => {
    const base = [criterion("features/a.feature", 3, "old", "X")];
    const copy = criterion("features/0.feature", 3, "copy", "X");
    const renamed = criterion("features/a.feature", 3, "renamed", "X");
    for (const head of [[copy, renamed], [renamed, copy]]) {
      const comparison = compareCriteria(base, head);
      expect(comparison.changes.get(criterionKey("features/a.feature", 3))).toEqual({
        change: "unchanged",
        at: { feature: "features/a.feature", line: 3 },
        renamedFrom: { feature: "features/a.feature", name: "old" },
      });
      expect(comparison.changes.get(criterionKey("features/0.feature", 3))).toEqual({ change: "new" });
    }
  });

  it("takes no rename from another file when more than one candidate matches", () => {
    const base = [criterion("features/a.feature", 3, "one", "X"), criterion("features/b.feature", 3, "two", "X")];
    const comparison = compareCriteria(base, [criterion("features/c.feature", 3, "three", "X")]);
    expect(comparison.changes.get(criterionKey("features/c.feature", 3))).toEqual({ change: "new" });
    expect(comparison.removed).toEqual(base);
  });

  it("does not depend on the order the feature files were read in", () =>
    hegel.test((tc) => {
      const files = ["features/a.feature", "features/b.feature", "features/c.feature"];
      const entry = gs.tuples(gs.sampledFrom(files), gs.sampledFrom(["one", "two", "three"]), gs.sampledFrom(["A", "B"]));
      const side = (drawn: [string, string, string][]): Criterion[] => drawn.map(([feature, name, content], index) => criterion(feature, index + 1, name, content));
      const base = side(tc.draw(gs.arrays(entry, { maxSize: 6 })));
      const head = side(tc.draw(gs.arrays(entry, { maxSize: 6 })));
      // Another order of the files, each file's criteria kept in its own order.
      const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].map((order) => order.map((index) => files[index]!));
      const rank = new Map(tc.draw(gs.sampledFrom(orders)).map((file, index) => [file, index]));
      const reordered = (list: Criterion[]): Criterion[] => [...list].sort((a, b) => rank.get(a.feature)! - rank.get(b.feature)! || a.line - b.line);
      const canonical = (comparison: ReturnType<typeof compareCriteria>) => ({
        changes: [...comparison.changes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        removed: comparison.removed.map((entry) => criterionKey(entry.feature, entry.line)).sort(),
      });
      expect(canonical(compareCriteria(reordered(base), reordered(head)))).toEqual(canonical(compareCriteria(base, head)));
    }));

  it("leaves a name that repeats with differing content new and removed rather than pairing by position", () => {
    const base = [criterion("f", 3, "same", "A"), criterion("f", 6, "same", "B")];
    const head = [criterion("f", 3, "same", "C"), criterion("f", 6, "same", "D")];
    const comparison = compareCriteria(base, head);
    expect([...comparison.changes.values()]).toEqual([{ change: "new" }, { change: "new" }]);
    expect(comparison.removed).toEqual(base);
  });

  it("counts every criterion once: each head criterion has one change, and a base criterion is matched or removed", () =>
    hegel.test((tc) => {
      const entry = gs.tuples(gs.sampledFrom(["f", "g"]), gs.sampledFrom(["one", "two", "three"]), gs.sampledFrom(["A", "B", "C"]));
      const base = tc.draw(gs.arrays(entry, { maxSize: 5 })).map(([feature, name, content], index) => criterion(feature, index + 1, name, content));
      const head = tc.draw(gs.arrays(entry, { maxSize: 5 })).map(([feature, name, content], index) => criterion(feature, index + 1, name, content));
      const comparison = compareCriteria(base, head);
      expect(comparison.changes.size).toBe(head.length);
      const matched = [...comparison.changes.values()].filter((change) => change.change !== "new").length;
      expect(matched + comparison.removed.length).toBe(base.length);
      for (const change of comparison.changes.values()) {
        if (change.change !== "unchanged") continue;
        const found = base.find((candidate) => candidate.feature === change.at.feature && candidate.line === change.at.line);
        expect(found).toBeDefined();
        expect(comparison.removed).not.toContain(found);
      }
    }));
});
