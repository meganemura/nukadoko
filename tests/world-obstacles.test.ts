import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Generator } from "@hegeldev/hegel/generators";
import { entryKindOfMode, worldObstacles, type ObstacleFacts, type SideEntry } from "../src/run/world-obstacles.js";

// Responsibility: what keeps `nuka run --base` from building a world
// (src/run/world-obstacles.ts). A repository with no symbolic link in the
// criteria or the mapping, no submodule or nested repository, no selected
// feature file outside the features directory, and no package linked into
// the repository has no obstacle; each of those adds one for the worlds
// docs/spec.md "Verdicts" names, and the answer does not depend on the order
// the facts are listed in.

const FEATURES = "app/features";
const filePaths = ["app/features/cart.feature", "app/features/steps/a-cart.ts", "app/features/support/hooks.ts", "app/lib/cart.mjs", "app/package.json", "README.md"];
const fileEntries: Generator<SideEntry[]> = gs.arrays(gs.sampledFrom(filePaths), { maxSize: 6 }).map((paths) => [...new Set(paths)].map((path) => ({ path, kind: "file" as const })));
const clean: Generator<ObstacleFacts> = gs
  .tuples(
    fileEntries,
    fileEntries,
    gs.arrays(gs.sampledFrom(["app/features/cart.feature", "app/features/more/b.feature"]), { maxSize: 2 }),
    gs.arrays(
      gs.oneOf(
        gs.sampledFrom(["app/node_modules/zod", "node_modules/@scope/kit"]).map((path) => ({ path, target: null as string | null })),
        gs.sampledFrom(["app/node_modules/zod", "node_modules/@scope/kit"]).map((path) => ({ path, target: "node_modules/.pnpm/kit@1.0.0/node_modules/kit" })),
      ),
      { maxSize: 2 },
    ),
  )
  .map(([head, ref, features, linkedPackages]) => ({
    project: "app",
    head: { entries: head, featuresDir: FEATURES, config: "app/nukadoko.config.ts" },
    ref: { entries: ref, featuresDir: FEATURES, config: "app/nukadoko.config.ts" },
    features: [...new Set(features)],
    linkedPackages,
  }));

type Anomaly = { readonly side: "head" | "ref"; readonly add: (facts: ObstacleFacts) => ObstacleFacts; readonly kind: string; readonly worlds: readonly string[]; readonly hidesMapping: boolean };
const onSide = (side: "head" | "ref", entry: SideEntry) => (facts: ObstacleFacts): ObstacleFacts => ({
  ...facts,
  [side]: { ...facts[side], entries: [...facts[side].entries, entry] },
});
const anomaly: Generator<Anomaly> = gs.sampledFrom(["head", "ref"] as const).flatMap((side) =>
  gs.sampledFrom<Anomaly>([
    { side, add: onSide(side, { path: "app/features/steps", kind: "link" }), kind: "link", worlds: ["base", "old"], hidesMapping: true },
    { side, add: onSide(side, { path: "app", kind: "link" }), kind: "link", worlds: ["base", "old"], hidesMapping: true },
    { side, add: onSide(side, { path: "app/nukadoko.config.ts", kind: "link" }), kind: "link", worlds: ["base", "old"], hidesMapping: true },
    { side, add: onSide(side, { path: "vendor/sub", kind: "repository" }), kind: "nested-repository", worlds: ["base", "old"], hidesMapping: false },
    { side, add: onSide(side, { path: "app/features/vendor", kind: "repository" }), kind: "nested-repository", worlds: ["base", "old"], hidesMapping: true },
    { side, add: (facts) => ({ ...facts, features: [...facts.features, "app/extra/c.feature"] }), kind: "outside-features", worlds: ["base", "old"], hidesMapping: true },
    { side, add: (facts) => ({ ...facts, linkedPackages: [...facts.linkedPackages, { path: "node_modules/cart", target: "packages/cart" }] }), kind: "workspace-package", worlds: ["base"], hidesMapping: false },
  ]),
);

function shuffled<T>(items: readonly T[], keys: readonly number[]): T[] {
  return items.map((item, index) => [keys[index % Math.max(keys.length, 1)] ?? 0, index, item] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , item]) => item);
}

describe("worldObstacles", () => {
  it("finds nothing in a repository of plain files, feature files under the features directory, and installed packages", () =>
    hegel.test((tc) => {
      expect(worldObstacles(tc.draw(clean))).toEqual({ obstacles: [], mappingUnseen: [] });
    }));

  it("keeps the worlds each shape names from being built, and hides the mapping where it reaches into it", () =>
    hegel.test((tc) => {
      const shape = tc.draw(anomaly);
      const { obstacles, mappingUnseen } = worldObstacles(shape.add(tc.draw(clean)));
      expect(obstacles.map((obstacle) => obstacle.world)).toEqual(shape.worlds);
      for (const obstacle of obstacles) expect(obstacle.kind).toBe(shape.kind);
      expect(mappingUnseen.length > 0).toBe(shape.hidesMapping);
    }));

  it("gives the same answer whatever order the facts are listed in", () =>
    hegel.test((tc) => {
      const facts = tc.draw(gs.arrays(anomaly, { maxSize: 3 })).reduce((sum, shape) => shape.add(sum), tc.draw(clean));
      const keys = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 9 }), { minSize: 1, maxSize: 8 }));
      const reordered: ObstacleFacts = {
        ...facts,
        head: { ...facts.head, entries: shuffled(facts.head.entries, keys) },
        ref: { ...facts.ref, entries: shuffled(facts.ref.entries, keys) },
        features: shuffled(facts.features, keys),
        linkedPackages: shuffled(facts.linkedPackages, keys),
      };
      expect(worldObstacles(reordered)).toEqual(worldObstacles(facts));
    }));

  it("says what each shape is, from the project root, and the edit that lets --base build the world", () => {
    const facts: ObstacleFacts = {
      project: "app",
      head: { entries: [{ path: "app/features/steps", kind: "link" }], featuresDir: FEATURES, config: null },
      ref: { entries: [{ path: "vendor/sub", kind: "repository" }], featuresDir: FEATURES, config: null },
      features: ["app/extra/c.feature"],
      linkedPackages: [{ path: "node_modules/cart", target: "packages/cart" }],
    };
    expect(worldObstacles(facts)).toEqual({
      obstacles: [
        {
          world: "base",
          kind: "link",
          path: "features/steps",
          reason: "features/steps is a symbolic link in the criteria or the mapping, and --base does not follow symbolic links yet",
          fix: "replace the symbolic link features/steps with the files it points to",
        },
        {
          world: "base",
          kind: "outside-features",
          path: "extra/c.feature",
          reason: "extra/c.feature is outside the features directory features, and --base compares only the criteria and steps under it",
          fix: "move extra/c.feature under features",
        },
        {
          world: "base",
          kind: "workspace-package",
          path: "../node_modules/cart",
          reason:
            "../node_modules/cart links to a package inside the repository, so the base world would run head's copy of it as the base's code, and --base does not support workspace packages yet",
        },
        {
          world: "base",
          kind: "nested-repository",
          path: "../vendor/sub",
          reason: "../vendor/sub is a submodule or a repository of its own, and --base does not support submodules or nested repositories yet",
        },
        {
          world: "old",
          kind: "link",
          path: "features/steps",
          reason: "features/steps is a symbolic link in the criteria or the mapping, and --base does not follow symbolic links yet",
          fix: "replace the symbolic link features/steps with the files it points to",
        },
        {
          world: "old",
          kind: "outside-features",
          path: "extra/c.feature",
          reason: "extra/c.feature is outside the features directory features, and --base compares only the criteria and steps under it",
          fix: "move extra/c.feature under features",
        },
        {
          world: "old",
          kind: "nested-repository",
          path: "../vendor/sub",
          reason: "../vendor/sub is a submodule or a repository of its own, and --base does not support submodules or nested repositories yet",
        },
      ],
      mappingUnseen: [
        "extra/c.feature is outside the features directory features, and --base compares only the criteria and steps under it",
        "features/steps is a symbolic link in the criteria or the mapping, and --base does not follow symbolic links yet",
      ],
    });
  });

  it("reads a symbolic link and a gitlink from their git modes", () => {
    expect(["100644", "100755", "120000", "160000"].map(entryKindOfMode)).toEqual(["file", "file", "link", "repository"]);
  });
});
