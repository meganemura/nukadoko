import { afterEach, describe, expect, it } from "vitest";
import { feature, makeBaseProject, scenario, type BaseProject, type TableRow } from "./helpers/base-project.js";
import { removeTempDir } from "./helpers/fixtures.js";

// Responsibility: what a run's table says of a scenario a hook failed
// while none of its steps did (docs/spec.md "Verdicts"): the cell stands
// at the scenario's line, and its reason and its row's name the hook and
// when it ran, since an After hook that failed after every claim was
// judged stopped nothing before a claim.

let project: (BaseProject & { readonly top: string }) | undefined;

afterEach(async () => {
  if (project !== undefined) await removeTempDir(project.top);
  project = undefined;
});

async function rowOf(hook: string): Promise<TableRow> {
  project = await makeBaseProject();
  project.write({
    "features/cart.feature": feature(scenario("three items", 3, 6)),
    "features/support/hooks.ts": `import { ${hook} } from "nukadoko/compat";\n${hook}(function () {\n  throw new Error("teardown failed");\n});\n`,
  });
  const result = await project.cli(["run", "--json"]);
  expect(result.exitCode).toBe(1);
  return (JSON.parse(result.stdout) as { table: { rows: TableRow[] } }).table.rows[0]!;
}

describe("a scenario whose hook failed and whose steps did not", () => {
  it("names an After hook that failed after its steps passed", async () => {
    const row = await rowOf("After");
    expect(row.cells).toEqual([
      { world: "head", environment: "default", role: "required", conditions: {}, outcome: "broke", line: 3, runs: 1, reason: "an After hook failed after its steps passed" },
    ]);
    expect([row.verdict, row.reason]).toEqual(["failed", "in default, an After hook failed after its steps passed"]);
  }, 60_000);

  it("names an AfterStep hook and the step it ran after", async () => {
    const row = await rowOf("AfterStep");
    expect([row.verdict, row.reason]).toEqual(["failed", "in default, an AfterStep hook failed after the step at line 4 passed"]);
  }, 60_000);

  it("names a Before hook, which stopped its steps before they ran", async () => {
    const row = await rowOf("Before");
    expect([row.verdict, row.reason]).toEqual(["failed", "in default, a Before hook failed before its steps ran"]);
  }, 60_000);
});
