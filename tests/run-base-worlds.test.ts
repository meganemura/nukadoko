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

describe("a url function", () => {
  const program = (url: string): string => `import { defineProgram } from "nukadoko";\nexport default defineProgram({ url: ${url} });\n`;

  async function urlProject(url: string): Promise<BaseProject & { readonly top: string }> {
    const made = await makeBaseProject();
    made.write({ "nukadoko.program.ts": program(url), "features/cart.feature": feature(scenario("three items", 3, 6)) });
    made.commit("base");
    made.git("branch", "base-branch");
    // Head discounts five items, and a new criterion says so.
    made.write({
      "lib/cart.mjs": cartModule("return count >= 5 ? count * 2 - 1 : count * 2;"),
      "features/cart.feature": feature(scenario("three items", 3, 6), scenario("five items", 5, 9)),
    });
    made.commit("head");
    return made;
  }

  it("that answers the base with head's URL leaves the base world unavailable, so nothing proves the new row", async () => {
    project = await urlProject(`() => "http://127.0.0.1:9/"`);
    const result = await project.cli(["run", "--base", "base-branch"]);
    expect(result.exitCode).toBe(1);
    const [, five] = rows(project.root);
    expect(rowSummary([five!])).toEqual([["five items", "new", "unproven", ["head:default:pass", "base:default:not-run"]]]);
    expect(five!.cells[1]!.reason).toBe("the base world has no URL to reach: the url function returned head's URL for the base tree; branch on `tree`");
    expect(result.stderr).toContain("base default  not run: the base world has no URL to reach: the url function returned head's URL for the base tree; branch on `tree`");
  }, 60_000);

  it("that branches on tree runs the base world, where the new row's Then fails", async () => {
    project = await urlProject(`({ tree }) => (tree === "base" ? "http://127.0.0.1:8/" : "http://127.0.0.1:9/")`);
    const result = await project.cli(["run", "--base", "base-branch"]);
    expect(result.exitCode).toBe(0);
    const [, five] = rows(project.root);
    expect(rowSummary([five!])).toEqual([["five items", "new", "proven", ["head:default:pass", "base:default:fail"]]]);
  }, 60_000);
});
