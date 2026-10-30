import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { inRunOrder, MAX_ORDER_SEED, orderText, readOrder, replayTargets, type PassScenario } from "../src/run/run-order.js";

// Responsibility: the order `nuka run --order` gives a selection, and the
// rerun targets that replay it (src/run/run-order.ts), as properties over
// drawn selections and seeds: a shuffle is a permutation that keeps each
// file whole, a seed names one order whatever order the selection came
// in, any part of a selection keeps the order the whole gave it, and the
// targets a rerun names select exactly what ran before a scenario, in
// the order it ran.

interface File {
  readonly relativePath: string;
  readonly pickles: readonly { readonly location: { readonly line: number } }[];
  readonly selectedLines: readonly number[] | null;
}

const seeds = gs.integers({ minValue: 0, maxValue: MAX_ORDER_SEED });

// Up to six files of up to six scenarios each, every line distinct in its
// file and every path distinct, as a selection gives them.
const selections = gs
  .arrays(gs.sets(gs.integers({ minValue: 1, maxValue: 60 }), { minSize: 1, maxSize: 6 }), { minSize: 1, maxSize: 6 })
  .map((files) =>
    files.map(
      (lines, index): File => ({
        relativePath: `features/f${index}.feature`,
        pickles: [...lines].sort((a, b) => a - b).map((line) => ({ location: { line } })),
        selectedLines: null,
      }),
    ),
  );

function sequenceOf(files: readonly File[]): PassScenario[] {
  return files.flatMap((file) => file.pickles.map((pickle) => ({ feature: file.relativePath, line: pickle.location.line })));
}

function keyOf(scenario: PassScenario): string {
  return `${scenario.feature}:${scenario.line}`;
}

describe("inRunOrder", () => {
  it("leaves the selection as it is in file order", () =>
    hegel.test((tc) => {
      const files = tc.draw(selections);
      expect(inRunOrder(files, { kind: "file" })).toEqual(files);
    }));

  it("runs every selected scenario once, each file's scenarios one after another", () =>
    hegel.test((tc) => {
      const files = tc.draw(selections);
      const ordered = inRunOrder(files, { kind: "shuffled", seed: tc.draw(seeds) });
      const ran = sequenceOf(ordered);
      expect(ran.map(keyOf).sort()).toEqual(sequenceOf(files).map(keyOf).sort());
      const seen = new Set<string>();
      ran.forEach((scenario, index) => {
        if (index > 0 && ran[index - 1]!.feature === scenario.feature) return;
        expect(seen.has(scenario.feature), `${scenario.feature} ran in two places`).toBe(false);
        seen.add(scenario.feature);
      });
      for (const file of ordered) expect(file.selectedLines).toEqual(file.pickles.map((pickle) => pickle.location.line));
    }));

  it("gives one seed one order, whatever order the selection arrives in", () =>
    hegel.test((tc) => {
      const files = tc.draw(selections);
      const seed = tc.draw(seeds);
      const reversed = [...files].reverse().map((file) => ({ ...file, pickles: [...file.pickles].reverse() }));
      expect(sequenceOf(inRunOrder(reversed, { kind: "shuffled", seed }))).toEqual(sequenceOf(inRunOrder(files, { kind: "shuffled", seed })));
    }));

  it("keeps any part of a selection in the order the whole selection gave it", () =>
    hegel.test((tc) => {
      const files = tc.draw(selections);
      const seed = tc.draw(seeds);
      const kept = files.flatMap((file) => {
        const pickles = file.pickles.filter(() => tc.draw(gs.booleans()));
        return pickles.length === 0 ? [] : [{ ...file, pickles }];
      });
      const keptKeys = new Set(sequenceOf(kept).map(keyOf));
      const whole = sequenceOf(inRunOrder(files, { kind: "shuffled", seed })).filter((scenario) => keptKeys.has(keyOf(scenario)));
      expect(sequenceOf(inRunOrder(kept, { kind: "shuffled", seed }))).toEqual(whole);
    }));
});

// A seed in a run.json or a summary has to name the same order for every
// nukadoko that reads it later, so the key is part of the format: these
// orders change only with an upgrade note.
describe("the order a seed names", () => {
  it("stays the same across versions", () => {
    const file = (relativePath: string, lines: readonly number[]): File => ({ relativePath, pickles: lines.map((line) => ({ location: { line } })), selectedLines: null });
    const selection = [file("features/a.feature", [3, 8, 13]), file("features/b.feature", [4, 9]), file("features/c/d.feature", [2])];
    const named = (seed: number) => sequenceOf(inRunOrder(selection, { kind: "shuffled", seed })).map(keyOf);
    expect(named(0)).toEqual(["features/c/d.feature:2", "features/b.feature:9", "features/b.feature:4", "features/a.feature:3", "features/a.feature:8", "features/a.feature:13"]);
    expect(named(1)).toEqual(["features/c/d.feature:2", "features/a.feature:3", "features/a.feature:8", "features/a.feature:13", "features/b.feature:4", "features/b.feature:9"]);
    expect(named(MAX_ORDER_SEED)).toEqual(["features/c/d.feature:2", "features/b.feature:4", "features/b.feature:9", "features/a.feature:8", "features/a.feature:3", "features/a.feature:13"]);
  });
});

describe("replayTargets", () => {
  it("names what ran before a scenario in its pass, then it, in the order the pass ran them", () =>
    hegel.test((tc) => {
      const all = tc.draw(selections);
      const seed = tc.draw(seeds);
      // A file a target named whole selects all of its scenarios; one named
      // by lines selects those lines.
      const wholeFiles = new Set(all.filter(() => tc.draw(gs.booleans())).map((file) => file.relativePath));
      const files = all.map((file) => (wholeFiles.has(file.relativePath) ? file : { ...file, pickles: file.pickles.filter((_, index) => index === 0 || tc.draw(gs.booleans())) }));
      const sequence = sequenceOf(inRunOrder(files, { kind: "shuffled", seed }));
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: sequence.length - 1 }));
      const targets = replayTargets(sequence, wholeFiles, sequence[at]!);

      // What the targets select, read the way a selection reads them: a
      // file named whole selects every scenario it holds.
      const selected = new Map<string, Set<number>>();
      for (const target of targets) {
        const match = /^(.+):(\d+)$/.exec(target);
        const feature = match === null ? target : match[1]!;
        const lines = match === null ? all.find((file) => file.relativePath === feature)!.pickles.map((pickle) => pickle.location.line) : [Number(match[2])];
        selected.set(feature, new Set([...(selected.get(feature) ?? []), ...lines]));
      }
      const rerun: File[] = [...selected.entries()].map(([relativePath, lines]) => ({
        relativePath,
        pickles: [...lines].sort((a, b) => a - b).map((line) => ({ location: { line } })),
        selectedLines: null,
      }));
      expect(sequenceOf(inRunOrder(rerun, { kind: "shuffled", seed }))).toEqual(sequence.slice(0, at + 1));
    }));

  it("names a file whole only when the targets named it whole and all of it ran first", () => {
    const sequence: PassScenario[] = [
      { feature: "features/a.feature", line: 3 },
      { feature: "features/a.feature", line: 9 },
      { feature: "features/b.feature", line: 7 },
      { feature: "features/b.feature", line: 4 },
    ];
    const whole = new Set(["features/a.feature", "features/b.feature"]);
    expect(replayTargets(sequence, whole, { feature: "features/b.feature", line: 7 })).toEqual(["features/a.feature", "features/b.feature:7"]);
    expect(replayTargets(sequence, whole, { feature: "features/b.feature", line: 4 })).toEqual(["features/a.feature", "features/b.feature"]);
    expect(replayTargets(sequence, new Set(), { feature: "features/b.feature", line: 7 })).toEqual(["features/a.feature:3", "features/a.feature:9", "features/b.feature:7"]);
  });
});

describe("readOrder", () => {
  it("reads back the order it spells, for every seed", () =>
    hegel.test((tc) => {
      const order = { kind: "shuffled" as const, seed: tc.draw(seeds) };
      expect(readOrder(orderText(order))).toEqual(order);
    }));

  it("takes a drawn seed for shuffled alone, and file order by default", () => {
    expect(readOrder("shuffled", () => 42)).toEqual({ kind: "shuffled", seed: 42 });
    expect(readOrder(undefined)).toEqual({ kind: "file" });
    expect(readOrder("file")).toEqual({ kind: "file" });
  });

  it("refuses anything else", () => {
    for (const value of ["", "random", "shuffled:", "shuffled:-1", "shuffled:01", "shuffled:1.5", `shuffled:${MAX_ORDER_SEED + 1}`, "shuffled:99999999999", "file:1", "Shuffled"]) {
      expect(readOrder(value), value).toBeUndefined();
    }
  });
});
