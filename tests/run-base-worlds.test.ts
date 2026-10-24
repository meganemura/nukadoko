import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cartModule, feature, makeBaseProject, rowSummary, scenario, type BaseProject, type TableRow } from "./helpers/base-project.js";
import { latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: that each tree of `nuka run --base` runs the mix
// docs/spec.md "Verdicts" names, end to end, for the repository shapes
// that once ran the other side's files: the base world is the ref's code
// under head's criteria and mapping, and the old world is head's code
// under the ref's criteria and mapping.

let project: (BaseProject & { readonly top: string }) | undefined;

afterEach(async () => {
  if (project !== undefined) await removeTempDir(project.top);
  project = undefined;
});

function rows(root: string): TableRow[] {
  return (latestRunJson(root) as { table: { rows: TableRow[] } }).table.rows;
}

describe("a retag", () => {
  it("runs an unchanged row in the old world, under the ref's tags and head's code", async () => {
    project = await makeBaseProject();
    // A hook selected by a tag holds an empty cart to costing nothing.
    project.write({
      "features/support/strict.ts": `import { After } from "nukadoko/compat";
import { total } from "../../lib/cart.mjs";

After({ tags: "@strict" }, function () {
  if (total(0) !== 0) throw new Error("an empty cart must cost nothing");
});
`,
      "features/cart.feature": feature(scenario("three items", 3, 6, "@strict")),
    });
    project.commit("base");
    project.git("branch", "base-branch");
    // Head breaks what the hook checks, and drops the tag that selects it.
    project.write({ "lib/cart.mjs": cartModule("return count === 0 ? 1 : count * 2;"), "features/cart.feature": feature(scenario("three items", 3, 6, "@smoke")) });
    project.commit("head");
    const result = await project.cli(["run", "--base", "base-branch"]);
    expect(result.exitCode).toBe(1);
    const [row] = rows(project.root);
    expect(rowSummary([row!])).toEqual([["three items", "unchanged", "moved", ["head:default:pass", "old:default:broke"]]]);
    expect(row!.retagged).toBe(true);
    expect(row!.reason).toMatch(/^passes in default, but its tags changed since the base, and it stopped at line 4 of the base's feature file in the old world in default/);
    const document = latestRunJson(project.root) as { run_dir: string };
    expect(readFileSync(path.join(project.root, document.run_dir, "summary.md"), "utf8")).toContain("| unchanged, retagged |");
  }, 60_000);
});
