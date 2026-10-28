import { afterEach, describe, expect, it } from "vitest";
import { CART_STEP, cartModule, feature, makeBaseProject, scenario, type BaseProject, type TableRow } from "./helpers/base-project.js";
import { removeTempDir } from "./helpers/fixtures.js";

// Responsibility: that the `do:` line of a `criterion-unproven` or
// `criterion-moved` finding, run as printed, judges the row again against
// the same comparison the run made (docs/spec.md "Verdicts"): the same
// commit, whatever the ref names by then, and the same criteria,
// whatever the targets select.

let project: (BaseProject & { readonly top: string }) | undefined;

afterEach(async () => {
  if (project !== undefined) await removeTempDir(project.top);
  project = undefined;
});

interface Judged {
  readonly exitCode: number;
  readonly rows: readonly TableRow[];
  readonly findings: readonly { readonly code: string; readonly do?: string }[];
}

async function judge(made: BaseProject, args: readonly string[]): Promise<Judged> {
  const result = await made.cli(["run", "--json", ...args]);
  const document = JSON.parse(result.stdout) as { table: { rows: TableRow[] }; findings: { code: string; do?: string }[] };
  return {
    exitCode: result.exitCode,
    rows: document.table.rows,
    findings: document.findings.filter((finding) => finding.code.startsWith("criterion-")).map((finding) => ({ code: finding.code, do: finding.do })),
  };
}

/** The arguments of a `do:` line, which names no path with a space. */
function argsOf(line: string): string[] {
  const [nuka, ...args] = line.split(" ");
  expect(nuka).toBe("nuka");
  return args.slice(1);
}

describe("the do: line of a moved row", () => {
  it("compares the row with the base's criteria in every file, so a row moved to another file stays moved", async () => {
    project = await makeBaseProject();
    project.write({ "features/cart.feature": feature(scenario("three items", 3, 6)) });
    const base = project.commit("base");
    // Head stops doubling in the code and doubles in the step instead, and
    // the scenario moves to a file of its own.
    project.write({
      "lib/cart.mjs": cartModule("return count;"),
      "features/steps/a-cart.ts": CART_STEP.replace("total: total(count)", "total: total(count) * 2"),
      "features/cart.feature": "Feature: Cart\n",
      "features/three.feature": "Feature: Three\n\n" + scenario("three items", 3, 6),
    });
    project.commit("head");
    const first = await judge(project, ["--base", base]);
    expect(first.rows.map((row) => [row.name, row.change, row.verdict])).toEqual([["three items", "unchanged", "moved"]]);
    expect(first.findings).toEqual([{ code: "criterion-moved", do: `nuka run features/three.feature:3 --base ${base}` }]);
    const again = await judge(project, argsOf(first.findings[0]!.do!));
    expect(again.exitCode).toBe(1);
    expect(again.rows.map((row) => [row.name, row.change, row.renamed_from, row.verdict])).toEqual([
      ["three items", "unchanged", { feature: "features/cart.feature", name: "three items" }, "moved"],
    ]);
  }, 60_000);
});

describe("a run that targets the file a criterion moved out of", () => {
  it("does not call the criterion removed, since head holds it in another file", async () => {
    project = await makeBaseProject();
    project.write({ "features/cart.feature": feature(scenario("three items", 3, 6), scenario("four items", 4, 8)) });
    const base = project.commit("base");
    project.write({ "features/cart.feature": feature(scenario("four items", 4, 8)), "features/three.feature": "Feature: Three\n\n" + scenario("three items", 3, 6) });
    project.commit("head");
    const judged = await judge(project, ["features/cart.feature", "--base", base]);
    expect(judged.exitCode).toBe(0);
    expect(judged.rows.map((row) => [row.name, row.change, row.verdict])).toEqual([["four items", "unchanged", "held"]]);
  }, 60_000);

  it("still calls removed a criterion head no longer holds anywhere", async () => {
    project = await makeBaseProject();
    project.write({ "features/cart.feature": feature(scenario("three items", 3, 6), scenario("four items", 4, 8)), "features/five.feature": "Feature: Five\n\n" + scenario("five items", 5, 10) });
    const base = project.commit("base");
    project.write({ "features/cart.feature": feature(scenario("four items", 4, 8)), "features/five.feature": "Feature: Five\n" });
    project.commit("head");
    const judged = await judge(project, ["features/cart.feature", "--base", base]);
    expect(judged.rows.map((row) => [row.feature, row.name, row.change, row.verdict])).toEqual([
      ["features/cart.feature", "four items", "unchanged", "held"],
      ["features/cart.feature", "three items", "removed", "removed"],
    ]);
  }, 60_000);
});

describe("the do: line of an unproven row", () => {
  it("names the commit the ref resolved to, so it still compares with that commit once the ref moves", async () => {
    project = await makeBaseProject();
    project.write({ "features/cart.feature": feature(scenario("three items", 3, 6)) });
    const base = project.commit("base");
    // Uncommitted work adds a scenario the base's code already passes.
    project.write({ "features/cart.feature": feature(scenario("three items", 3, 6), scenario("four items", 4, 8)) });
    const first = await judge(project, ["--base", "HEAD"]);
    expect(first.exitCode).toBe(1);
    expect(first.findings).toEqual([{ code: "criterion-unproven", do: `nuka run features/cart.feature:7 --base ${base}` }]);
    // The work is committed, so HEAD now holds the scenario.
    project.commit("four items");
    const again = await judge(project, argsOf(first.findings[0]!.do!));
    expect(again.exitCode).toBe(1);
    expect(again.rows.map((row) => [row.name, row.change, row.verdict])).toEqual([["four items", "new", "unproven"]]);
  }, 60_000);
});
