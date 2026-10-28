import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CART_STEP, cartModule, feature, makeBaseProject, rowSummary, scenario, totalStep, type BaseProject, type TableRow } from "./helpers/base-project.js";
import { createEmptyTempDir, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: that each tree of `nuka run --base` runs the mix
// docs/spec.md "Verdicts" names, end to end, for the repository shapes
// that once ran the other side's files: the base world is the ref's code
// under head's criteria and mapping, and the old world is head's code
// under the ref's criteria and mapping. A shape a tree cannot hold that
// mix for leaves the world unbuilt, and its cells say why.

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
    expect(row!.reason).toBe("passes in default, but its tags changed since the base, and in the old world in default, an After hook failed after its steps passed");
    const document = latestRunJson(project.root) as { run_dir: string };
    expect(readFileSync(path.join(project.root, document.run_dir, "summary.md"), "utf8")).toContain("| unchanged, retagged |");
  }, 60_000);
});

describe("a rename", () => {
  it("runs an unchanged row in the old world, under the ref's name and head's code", async () => {
    project = await makeBaseProject();
    // A hook reads the scenario's name, as one may read its tags.
    project.write({
      "features/support/factor.ts": `import { Before } from "nukadoko/compat";

Before(function ({ pickle }) {
  process.env.FACTOR = pickle.name.includes("[triple]") ? "3" : "2";
});
`,
      "lib/cart.mjs": cartModule("return count * Number(process.env.FACTOR);"),
      "features/cart.feature": feature(scenario("three items", 3, 6)),
    });
    project.commit("base");
    project.git("branch", "base-branch");
    // Head subtracts 3 and renames the scenario so the hook triples, so
    // three items still total 6 at head, and 3 under the base's name.
    project.write({
      "lib/cart.mjs": cartModule("return count * Number(process.env.FACTOR) - 3;"),
      "features/cart.feature": feature(scenario("three items [triple]", 3, 6)),
    });
    project.commit("head");
    const result = await project.cli(["run", "--base", "base-branch"]);
    expect(result.exitCode).toBe(1);
    const [row] = rows(project.root);
    expect(rowSummary([row!])).toEqual([["three items [triple]", "unchanged", "moved", ["head:default:pass", "old:default:fail"]]]);
    expect(row!.reason).toBe(
      "passes in default, but its name or its file changed since the base, and a claim broke at line 5 of the base's feature file in the old world in default",
    );
  }, 60_000);
});

describe("the config file", () => {
  const configWith = (factor: number): string =>
    `import { defineConfig } from "nukadoko";\nconst FACTOR = ${factor};\nexport default defineConfig({\n  fixtures: {\n    factor: async ({}, use) => { await use(FACTOR); },\n  },\n});\n`;

  it("is mapping as the file reads, so a constant a fixture closes over sends an unchanged row to the old world", async () => {
    project = await makeBaseProject();
    project.write({
      "nukadoko.config.ts": configWith(2),
      "lib/cart.mjs": "export function total(count, factor) {\n  return count * factor;\n}\n",
      "features/steps/a-cart.ts": CART_STEP.replace("async run({}, { count }) {\n    return { total: total(count) };", "async run({ factor }, { count }) {\n    return { total: total(count, factor) };"),
      "features/cart.feature": feature(scenario("three items", 3, 6)),
    });
    project.commit("base");
    project.git("branch", "base-branch");
    // Head's code adds 3 and its constant drops to 1, so three items still
    // total 6 at head, and 9 under the base's config on head's code.
    project.write({ "nukadoko.config.ts": configWith(1), "lib/cart.mjs": "export function total(count, factor) {\n  return count * factor + 3;\n}\n" });
    project.commit("head");
    const result = await project.cli(["run", "--base", "base-branch"]);
    expect(result.exitCode).toBe(1);
    expect((latestRunJson(project.root) as { table: { mapping_changes: { config: boolean } } }).table.mapping_changes.config).toBe(true);
    expect(rowSummary(rows(project.root))).toEqual([["three items", "unchanged", "moved", ["head:default:pass", "old:default:fail"]]]);
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

describe("a state directory git does not ignore", () => {
  it("is not head's working tree, so the run's own base tree in it blocks no world", async () => {
    project = await makeBaseProject();
    writeFileSync(path.join(project.top, ".gitignore"), "node_modules/\n");
    project.write({ "lib/cart.mjs": cartModule("return count;"), "features/cart.feature": "Feature: Cart\n" });
    project.commit("base");
    project.write({ "lib/cart.mjs": cartModule(), "features/cart.feature": feature(scenario("three items", 3, 6)) });
    project.commit("head");
    const result = await project.cli(["run", "--base", "HEAD~1"]);
    expect(result.stderr).not.toContain("not run");
    expect(rowSummary(rows(project.root))).toEqual([["three items", "new", "proven", ["head:default:pass", "base:default:fail"]]]);
    expect(result.exitCode).toBe(0);
  }, 60_000);
});

describe("a compat Then", () => {
  it("leaves a new row unproven, and its reason says a compat step judges no claim, though the Then failed at the base", async () => {
    project = await makeBaseProject();
    project.write({
      "lib/cart.mjs": cartModule("return count;"),
      "features/cart.feature": "Feature: Cart\n",
      "features/steps/a-cart.ts": `import { Given, Then } from "nukadoko/compat";
import assert from "node:assert/strict";
import { total } from "../../lib/cart.mjs";
Given("a cart with {int} items", function (count: number) {
  this.total = total(count);
});
Then("the total is {int}", function (expected: number) {
  assert.equal(this.total, expected);
});
`,
    });
    rmSync(path.join(project.root, "features/steps/total-is.ts"));
    project.commit("base");
    project.write({ "lib/cart.mjs": cartModule(), "features/cart.feature": feature(scenario("three items", 3, 6)) });
    project.commit("head");
    const result = await project.cli(["run", "--no-check", "--base", "HEAD~1"]);
    expect(result.exitCode).toBe(1);
    const [row] = rows(project.root);
    expect(rowSummary([row!])).toEqual([["three items", "new", "unproven", ["head:default:pass", "base:default:broke"]]]);
    expect(row!.reason).toBe(
      "passes in default, but its Then is a compat step, which judges no claim, so no world can show a Then failing where its behaviour is absent (base default: broke@5)",
    );
  }, 60_000);
});

describe("a proof round that did not finish", () => {
  it("leaves the base world to prove a new row, since the control it ran proves nothing", async () => {
    project = await makeBaseProject();
    project.write({
      "nukadoko.program.ts": `import { defineProgram } from "nukadoko";
export default defineProgram({
  environments: {
    on: { conditions: { double: true }, env: { DOUBLE: "{condition.double}" } },
    off: { conditions: { double: false }, env: { DOUBLE: "{condition.double}" } },
  },
});
`,
      "lib/cart.mjs": cartModule("return count;"),
      "features/cart.feature": feature(scenario("one item", 1, 1, "@without:double")),
      "features/other.feature": "Feature: Other\n\n" + scenario("zero items", 0, 0),
    });
    project.commit("base");
    // Head doubles behind the switch, adds the row that needs it, and an
    // AfterAll that fails in its third call in off: each of off's two
    // workers calls it once, and the third is the worker of off's proof
    // round, after the control's second run was recorded.
    project.write({
      "lib/cart.mjs": cartModule('return process.env.DOUBLE === "true" ? count * 2 : count;'),
      "features/cart.feature": feature(scenario("one item", 1, 1, "@without:double"), scenario("three items", 3, 6, "@with:double")),
      "features/support/hooks.ts": `import { AfterAll } from "nukadoko/compat";
import { mkdirSync } from "node:fs";
AfterAll(function () {
  if (process.env.DOUBLE !== "false") return;
  for (let call = 1; ; call += 1) {
    try {
      mkdirSync(new URL(\`../../.calls/\${call}\`, import.meta.url), { recursive: false });
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") continue;
      throw error;
    }
    if (call >= 3) throw new Error("the proof round's AfterAll fails");
    return;
  }
});
`,
    });
    mkdirSync(path.join(project.root, ".calls"));
    project.commit("head");
    const result = await project.cli(["run", "--base", "HEAD~1", "--concurrency", "2"]);
    expect(result.stderr).toContain("proof-run-incomplete");
    const row = rows(project.root).find((entry) => entry.name === "three items")!;
    expect(row.cells.map((cell) => `${cell.world}:${cell.environment}:${cell.role}:${cell.outcome}:${cell.runs}`)).toEqual([
      "head:on:required:pass:1",
      "head:off:control:broke:2",
      "base:on:required:fail:2",
    ]);
    expect(row.verdict).toBe("proven");
    expect(result.exitCode).toBe(0);
  }, 60_000);
});

describe("the old world's environments", () => {
  const environments = (entries: Readonly<Record<string, string>>, defaults?: readonly string[]): string =>
    `import { defineProgram } from "nukadoko";\nexport default defineProgram({\n${defaults === undefined ? "" : `  defaultEnvironments: ${JSON.stringify(defaults)},\n`}  environments: {\n${Object.entries(
      entries,
    )
      .map(([name, conditions]) => `    ${name}: { conditions: ${conditions}, env: { WHERE: ${JSON.stringify(name)} } },`)
      .join("\n")}\n  },\n});\n`;
  // Head's code gets three items wrong in `b` alone.
  const wrongInB = cartModule('return process.env.WHERE === "b" ? 7 : count * 2;');

  function cellsOf(row: TableRow): string[] {
    return row.cells.map((cell) => `${cell.world}:${cell.environment}:${cell.role}:${cell.outcome}`);
  }

  it("are the ones the base's mapping requires the row in, so a cell head made a control still runs there", async () => {
    project = await makeBaseProject();
    project.write({
      "nukadoko.program.ts": environments({ a: "{ flag: true }", b: "{ flag: true }" }),
      "features/cart.feature": feature(scenario("three items", 3, 6, "@with:flag")),
    });
    project.commit("base");
    project.git("branch", "base-branch");
    // Head breaks the total in b and declares the flag off there, which
    // turns head's b cell into a control.
    project.write({ "lib/cart.mjs": wrongInB, "nukadoko.program.ts": environments({ a: "{ flag: true }", b: "{ flag: false }" }) });
    project.commit("head");
    const result = await project.cli(["run", "--base", "base-branch"]);
    expect(result.exitCode).toBe(1);
    const [row] = rows(project.root);
    expect(row!.verdict).toBe("moved");
    expect(cellsOf(row!)).toEqual(["head:a:required:pass", "head:b:control:fail", "old:a:required:pass", "old:b:required:fail"]);
    expect(row!.cells.find((cell) => cell.world === "old" && cell.environment === "b")!.conditions).toEqual({ flag: true });
  }, 60_000);

  it("start head's recipe of an environment the base selects and head's run does not", async () => {
    project = await makeBaseProject();
    project.write({
      "nukadoko.program.ts": environments({ a: "{ flag: true }", b: "{ flag: true }" }, ["a", "b"]),
      "features/cart.feature": feature(scenario("three items", 3, 6, "@with:flag")),
    });
    project.commit("base");
    project.git("branch", "base-branch");
    project.write({ "lib/cart.mjs": wrongInB, "nukadoko.program.ts": environments({ a: "{ flag: true }", b: "{ flag: true }" }, ["a"]) });
    project.commit("head");
    const result = await project.cli(["run", "--base", "base-branch"]);
    expect(result.exitCode).toBe(1);
    const [row] = rows(project.root);
    expect(row!.verdict).toBe("moved");
    expect(cellsOf(row!)).toEqual(["head:a:required:pass", "old:a:required:pass", "old:b:required:fail"]);
  }, 60_000);

  it("leave a cell not run where head's program file no longer has the environment", async () => {
    project = await makeBaseProject();
    project.write({
      "nukadoko.program.ts": environments({ a: "{ flag: true }", b: "{ flag: true }" }),
      "features/cart.feature": feature(scenario("three items", 3, 6, "@with:flag")),
    });
    project.commit("base");
    project.git("branch", "base-branch");
    project.write({ "nukadoko.program.ts": environments({ a: "{ flag: true }" }) });
    project.commit("head");
    const result = await project.cli(["run", "--base", "base-branch"]);
    expect(result.exitCode).toBe(1);
    const [row] = rows(project.root);
    expect(row!.verdict).toBe("moved");
    expect(cellsOf(row!)).toEqual(["head:a:required:pass", "old:a:required:pass", "old:b:required:not-run"]);
    expect(row!.reason).toBe(
      "passes in a, but the mapping changed since the base, and it did not run in the old world in b: the base's mapping requires this environment, and head's program file no longer has it",
    );
  }, 60_000);
});

describe("a shape --base cannot build a world for", () => {
  interface JudgedFinding {
    readonly code: string;
    readonly fix?: string;
    readonly do?: string;
  }

  async function judge(args: readonly string[] = []): Promise<{ exitCode: number; table: { mapping_changed: boolean; mapping_changes: { unseen: string[] } }; findings: JudgedFinding[] }> {
    const result = await project!.cli(["run", "--json", "--base", "base-branch", ...args]);
    const document = JSON.parse(result.stdout) as { table: { mapping_changed: boolean; mapping_changes: { unseen: string[] } }; findings: (JudgedFinding & { severity: string })[] };
    return {
      exitCode: result.exitCode,
      table: document.table,
      findings: document.findings.map(({ code, fix, do: command }) => ({ code, ...(fix === undefined ? {} : { fix }), ...(command === undefined ? {} : { do: command }) })),
    };
  }

  it("a symbolic link to the steps leaves both worlds unbuilt, so a shared Then head weakened neither holds a row nor proves one", async () => {
    project = await makeBaseProject();
    rmSync(path.join(project.root, "features", "steps"), { recursive: true });
    project.write({
      "shared-steps/a-cart.ts": CART_STEP.replace("../../lib/cart.mjs", "../lib/cart.mjs"),
      "shared-steps/total-is.ts": totalStep("equal"),
      "lib/cart.mjs": cartModule("return count === 4 ? 10 : count * 2;"),
      "features/cart.feature": feature(scenario("three items", 3, 6)),
    });
    symlinkSync("../shared-steps", path.join(project.root, "features", "steps"));
    project.commit("base");
    project.git("branch", "base-branch");
    // Head gets three items wrong and adds a criterion the base's code
    // fails only under the base's Then; weakening the shared Then hides both.
    project.write({
      "lib/cart.mjs": cartModule("return count === 3 ? 7 : count === 4 ? 9 : count * 2;"),
      "shared-steps/total-is.ts": totalStep("at-least"),
      "features/cart.feature": feature(scenario("three items", 3, 6), scenario("four items", 4, 8)),
    });
    project.commit("head");
    const judged = await judge();
    expect(judged.exitCode).toBe(1);
    const reason = "features/steps is a symbolic link in the criteria or the mapping, and --base does not follow symbolic links yet";
    expect(judged.table.mapping_changed).toBe(true);
    expect(judged.table.mapping_changes.unseen).toEqual([reason]);
    const [three, four] = rows(project.root);
    expect(rowSummary([three!, four!])).toEqual([
      ["three items", "unchanged", "moved", ["head:default:pass", "old:default:not-run"]],
      ["four items", "new", "unproven", ["head:default:pass", "base:default:not-run"]],
    ]);
    expect(three!.reason).toBe(`passes in default, but the mapping could not be compared with the base's, and it did not run in the old world in default: ${reason}`);
    expect(four!.cells[1]!.reason).toBe(reason);
    const fix = "replace the symbolic link features/steps with the files it points to";
    expect(judged.findings).toEqual([
      { code: "criterion-moved", fix, do: "nuka run features/cart.feature:3" },
      { code: "criterion-unproven", fix, do: "nuka run features/cart.feature:7" },
    ]);
  }, 60_000);

  it("a feature file outside the features directory leaves both worlds unbuilt", async () => {
    project = await makeBaseProject();
    project.write({ "extra/cart.feature": feature(scenario("three items", 3, 6)) });
    project.commit("base");
    project.git("branch", "base-branch");
    project.write({
      "lib/cart.mjs": cartModule("return count >= 5 ? count * 2 - 1 : count * 2;"),
      "extra/cart.feature": feature(scenario("three items", 3, 6), scenario("five items", 5, 9)),
    });
    project.commit("head");
    const judged = await judge(["extra/cart.feature"]);
    expect(judged.exitCode).toBe(1);
    const reason = "extra/cart.feature is outside the features directory features, and --base compares only the criteria and steps under it";
    expect(judged.table.mapping_changes.unseen).toEqual([reason]);
    expect(rowSummary(rows(project.root))).toEqual([
      ["three items", "unchanged", "moved", ["head:default:pass", "old:default:not-run"]],
      ["five items", "new", "unproven", ["head:default:pass", "base:default:not-run"]],
    ]);
    const fix = "move extra/cart.feature under features";
    expect(judged.findings).toEqual([
      { code: "criterion-moved", fix, do: "nuka run extra/cart.feature:3" },
      { code: "criterion-unproven", fix, do: "nuka run extra/cart.feature:7" },
    ]);
  }, 60_000);

  it("a workspace package leaves the base world unbuilt, rather than run head's copy as the base's code", async () => {
    project = await makeBaseProject();
    project.write({
      "packages/pricing/package.json": `${JSON.stringify({ name: "pricing", type: "module", main: "index.mjs" })}\n`,
      "packages/pricing/index.mjs": cartModule(),
      "features/steps/a-cart.ts": CART_STEP.replace("../../lib/cart.mjs", "pricing"),
      "features/cart.feature": feature(scenario("three items", 3, 6)),
    });
    // What a workspace install leaves; git ignores it.
    mkdirSync(path.join(project.root, "node_modules"));
    symlinkSync("../packages/pricing", path.join(project.root, "node_modules", "pricing"));
    project.commit("base");
    project.git("branch", "base-branch");
    project.write({
      "packages/pricing/index.mjs": cartModule("return count >= 5 ? count * 2 - 1 : count * 2;"),
      "features/cart.feature": feature(scenario("three items", 3, 6), scenario("five items", 5, 9)),
    });
    project.commit("head");
    const judged = await judge();
    expect(judged.exitCode).toBe(1);
    expect(judged.table.mapping_changed).toBe(false);
    const [three, five] = rows(project.root);
    expect(rowSummary([three!, five!])).toEqual([
      ["three items", "unchanged", "held", ["head:default:pass"]],
      ["five items", "new", "unproven", ["head:default:pass", "base:default:not-run"]],
    ]);
    expect(five!.cells[1]!.reason).toBe(
      "node_modules/pricing links to a package inside the repository, so the base world would run head's copy of it as the base's code, and --base does not support workspace packages yet",
    );
    expect(judged.findings).toEqual([{ code: "criterion-unproven", do: "nuka run features/cart.feature:7" }]);
  }, 60_000);

  it.each(["submodule", "nested repository"])("a %s leaves both worlds unbuilt, rather than stop the run", async (shape) => {
    project = await makeBaseProject();
    project.write({ "features/cart.feature": feature(scenario("three items", 3, 6)) });
    const nested = (dir: string): void => {
      const git = (...args: string[]): string => execFileSync("git", ["-C", dir, "-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { encoding: "utf8" });
      git("init", "-q");
      git("commit", "-q", "--allow-empty", "-m", "nested");
    };
    const source = await createEmptyTempDir();
    try {
      if (shape === "submodule") {
        nested(source);
        project.git("submodule", "add", "-q", source, "vendor/sub");
      }
      project.commit("base");
      project.git("branch", "base-branch");
      // A step file changes, so the unchanged row needs the old world.
      project.write({
        "features/steps/total-is.ts": `${totalStep("equal")}// reworded\n`,
        "features/cart.feature": feature(scenario("three items", 3, 6), scenario("four items", 4, 8)),
      });
      project.commit("head");
      // A clone inside the working tree that git does not track.
      if (shape === "nested repository") {
        mkdirSync(path.join(project.root, "vendor", "sub"), { recursive: true });
        nested(path.join(project.root, "vendor", "sub"));
      }
      const judged = await judge();
      expect(judged.exitCode).toBe(1);
      const reason = "vendor/sub is a submodule or a repository of its own, and --base does not support submodules or nested repositories yet";
      const [three, four] = rows(project.root);
      expect(rowSummary([three!, four!])).toEqual([
        ["three items", "unchanged", "moved", ["head:default:pass", "old:default:not-run"]],
        ["four items", "new", "unproven", ["head:default:pass", "base:default:not-run"]],
      ]);
      expect([three!.cells[1]!.reason, four!.cells[1]!.reason]).toEqual([reason, reason]);
      expect(judged.findings).toEqual([
        { code: "criterion-moved", do: "nuka run features/cart.feature:3" },
        { code: "criterion-unproven", do: "nuka run features/cart.feature:7" },
      ]);
    } finally {
      await removeTempDir(source);
    }
  }, 60_000);
});
