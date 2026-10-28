import { afterEach, describe, expect, it } from "vitest";
import { feature, makeBaseProject, scenario, type BaseProject, type TableRow } from "./helpers/base-project.js";
import { removeTempDir } from "./helpers/fixtures.js";

// Responsibility: that the `do:` line of a `criterion-unproven` or
// `criterion-moved` finding, run as printed, judges the row again against
// the same comparison the run made (docs/spec.md "Verdicts"): the same
// commit, whatever the ref names by then.

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
