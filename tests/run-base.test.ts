import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir, repoRoot } from "./helpers/fixtures.js";

// Responsibility: `nuka run --base <ref>` on a real git history, end to
// end: the base and the old tree, the worlds they run, each change kind and
// each of the six words, as run.json, the --json document, and the summary
// give them; and the refusals: `--since`, a ref that names nothing, a
// project outside git, and a shallow clone that lacks the ref.
//
// The program under test is a module the steps import (`lib/cart.mjs`),
// outside the features directory, so the base tree runs the base's copy of
// it and the old tree head's. Step files import nukadoko by an absolute
// URL, so they load from inside a tree as from the project.

const STEP_A_CART = `import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import { total } from "../../lib/cart.mjs";

export default defineStep({
  pattern: "a cart with {count:int} items",
  description: "Prices a cart of the given number of items",
  args: z.object({ count: z.number().int() }),
  returns: z.object({ total: z.number().int() }),
  mutates: false,
  async run({}, { count }) {
    return { total: total(count) };
  },
});
`;

const claimStep = (pattern: string, compare: string): string => `import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import aCart from "./a-cart.js";

export default defineStep({
  pattern: ${JSON.stringify(pattern)},
  description: "Checks the cart's total",
  args: z.object({ expected: z.number().int(), total: z.number().int() }),
  from: { total: [aCart, "total"] },
  claims: [{ actual: "total", compare: ${JSON.stringify(compare)}, expected: "expected" }],
});
`;

const BASE_FEATURE = `Feature: Cart

  Scenario: an empty cart
    Given a cart with 0 items
    Then the total is 0

  Scenario: three items
    Given a cart with 3 items
    Then the total is about 6

  Scenario: five items
    Given a cart with 5 items
    Then the total is 10

  Scenario: gone soon
    Given a cart with 1 items
    Then the total is 2
`;

// One of each: renamed, moved (three items, under a weakened step), changed
// and proven (five items), new and held (two items), new and unproven (four
// items), and removed (gone soon).
const HEAD_FEATURE = `Feature: Cart

  Scenario: a cart with nothing in it
    Given a cart with 0 items
    Then the total is 0

  Scenario: three items
    Given a cart with 3 items
    Then the total is about 6

  Scenario: five items
    Given a cart with 5 items
    Then the total is 9

  @held
  Scenario: two items
    Given a cart with 2 items
    Then the total is 4

  Scenario: four items
    Given a cart with 4 items
    Then the total is 8
`;

interface Cell {
  world: string;
  environment: string;
  role: string;
  conditions: Record<string, unknown>;
  outcome: string;
  line?: number;
  runs: number;
  claim?: number;
  actuals?: { value: unknown }[];
  reason?: string;
}
interface Row {
  feature: string;
  line: number;
  name: string;
  change: string | null;
  renamed_from?: { feature: string; name: string };
  conditions: string[];
  cells: Cell[];
  verdict: string;
  reason: string;
  lines?: string[];
}

describe("nuka run --base", () => {
  let rootDir: string;
  let base: string;
  let result: { exitCode: number; stdout: string; stderr: string };

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, "-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { encoding: "utf8" }).trim();

  async function cli(args: string[], at = rootDir): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(args, { rootDir: at, stdout, stderr });
    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  }

  beforeAll(async () => {
    rootDir = await copyFixtureToTempDir("allure-identity-project");
    for (const file of ["nukadoko.program.ts", "features/checkout.feature", "features/steps/a-cart.ts", "features/steps/cart-holds.ts"]) {
      rmSync(path.join(rootDir, file));
    }
    writeFileSync(path.join(rootDir, "nukadoko-shim.ts"), `export * from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "src", "index.ts")).href)};\n`);
    writeFileSync(path.join(rootDir, ".gitignore"), ".nukadoko/\n");
    mkdirSync(path.join(rootDir, "lib"));
    writeFileSync(path.join(rootDir, "lib", "cart.mjs"), "export function total(count) {\n  return count * 2;\n}\n");
    writeFileSync(path.join(rootDir, "features", "cart.feature"), BASE_FEATURE);
    writeFileSync(path.join(rootDir, "features", "steps", "a-cart.ts"), STEP_A_CART);
    writeFileSync(path.join(rootDir, "features", "steps", "total-is.ts"), claimStep("the total is {expected:int}", "equal"));
    writeFileSync(path.join(rootDir, "features", "steps", "total-about.ts"), claimStep("the total is about {expected:int}", "equal"));
    git(rootDir, "init", "-q");
    git(rootDir, "add", "-A");
    git(rootDir, "commit", "-qm", "base");
    base = git(rootDir, "rev-parse", "HEAD");
    git(rootDir, "branch", "base-branch");
    // Head: a discount from five items, a wrong total for three, and the
    // step under "about" weakened so head still passes it.
    writeFileSync(
      path.join(rootDir, "lib", "cart.mjs"),
      "export function total(count) {\n  if (count === 3) return 7;\n  return count >= 5 ? count * 2 - 1 : count * 2;\n}\n",
    );
    writeFileSync(path.join(rootDir, "features", "cart.feature"), HEAD_FEATURE);
    writeFileSync(path.join(rootDir, "features", "steps", "total-about.ts"), claimStep("the total is about {expected:int}", "at-least"));
    git(rootDir, "add", "-A");
    git(rootDir, "commit", "-qm", "head");
    result = await cli(["run", "--json", "--base", "base-branch"]);
  }, 120_000);

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("gives each row its change and its word, and fails on unproven and moved", () => {
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(1);
    const document = JSON.parse(result.stdout) as { table: { base: unknown; mapping_changed: boolean; mapping_changes: unknown; worlds: unknown; rows: Row[] } };
    expect(document.table.base).toEqual({ ref: "base-branch", commit: base });
    expect(document.table.mapping_changed).toBe(true);
    expect(document.table.mapping_changes).toEqual({ files: ["features/steps/total-about.ts"], config: false, conditions: [], default_environments: false });
    expect(document.table.worlds).toEqual([
      { world: "head", environment: "default" },
      { world: "base", environment: "default" },
      { world: "old", environment: "default" },
    ]);
    const head = (outcome: string, runs = 1, line?: number): Cell => ({
      world: "head",
      environment: "default",
      role: "required",
      conditions: {},
      outcome,
      ...(line === undefined ? {} : { line }),
      runs,
    });
    const at = (world: string, outcome: string, runs = 1, line?: number): Cell => ({ ...head(outcome, runs, line), world });
    // A fail cell names the claim every run broke, by its position in the
    // step, and keeps the value each run read.
    const failed = (world: string, line: number, values: number[]): Cell => ({ ...at(world, "fail", values.length, line), claim: 0, actuals: values.map((value) => ({ value })) });
    expect(document.table.rows).toEqual([
      {
        feature: "features/cart.feature",
        line: 3,
        name: "a cart with nothing in it",
        change: "unchanged",
        renamed_from: { feature: "features/cart.feature", name: "an empty cart" },
        conditions: [],
        cells: [head("pass"), at("old", "pass")],
        verdict: "held",
        reason: "passes in default, and in the old world, where the base's mapping runs head's code",
      },
      {
        feature: "features/cart.feature",
        line: 7,
        name: "three items",
        change: "unchanged",
        conditions: [],
        cells: [head("pass"), failed("old", 9, [7])],
        verdict: "moved",
        reason: "passes in default, but the mapping changed since the base, and a claim broke at line 9 of the base's feature file in the old world in default",
      },
      {
        feature: "features/cart.feature",
        line: 11,
        name: "five items",
        change: "changed",
        conditions: [],
        cells: [head("pass"), failed("base", 13, [10, 10])],
        verdict: "proven",
        reason: "passes in default, and a claim broke at line 13 at the base in default in each of 2 runs",
      },
      {
        feature: "features/cart.feature",
        line: 16,
        name: "two items",
        change: "new",
        conditions: ["@held"],
        cells: [head("pass"), at("base", "pass")],
        verdict: "held",
        reason: "passes in default and at the base, as @held says",
      },
      {
        feature: "features/cart.feature",
        line: 20,
        name: "four items",
        change: "new",
        conditions: [],
        cells: [head("pass"), at("base", "pass")],
        verdict: "unproven",
        reason: "passes in default, and nothing shows a Then failing where its behaviour is absent (base default: pass)",
      },
      {
        feature: "features/cart.feature",
        line: 15,
        name: "gone soon",
        change: "removed",
        conditions: [],
        cells: [],
        verdict: "removed",
        reason: "the base holds this criterion, and head no longer does",
        lines: ["Given a cart with 1 items", "Then the total is 2"],
      },
    ]);
  });

  it("records the base and the old world's executions with their world and row, and counts head's alone", () => {
    const document = latestRunJson(rootDir);
    const tree = (document.scenarios as { world?: string; row?: unknown; scenario: string; feature: string; line: number; do?: string }[]).filter(
      (scenario) => scenario.world !== undefined,
    );
    expect(tree.map((scenario) => [scenario.world, scenario.scenario, scenario.line, scenario.row])).toEqual(
      expect.arrayContaining([
        ["old", "an empty cart", 3, { feature: "features/cart.feature", line: 3 }],
        ["old", "three items", 7, { feature: "features/cart.feature", line: 7 }],
        ["base", "five items", 11, { feature: "features/cart.feature", line: 11 }],
        ["base", "two items", 16, { feature: "features/cart.feature", line: 16 }],
        ["base", "four items", 20, { feature: "features/cart.feature", line: 20 }],
      ]),
    );
    // Five items failed at the base, and ran once more for proof.
    expect(tree.filter((scenario) => scenario.scenario === "five items")).toHaveLength(2);
    expect(tree.every((scenario) => scenario.do === undefined)).toBe(true);
    expect(document.counts).toEqual({ scenarios: 5, passed: 5, failed: 0, controls: 0, controls_not_run: 0, not_run: 0 });
    // The trees are gone once the run is over.
    expect(existsSync(path.join(rootDir, document.run_dir as string, "trees"))).toBe(false);
    expect(git(rootDir, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("leads the summary with what it compared, the change column, the reasons, and the removed criteria", () => {
    const document = latestRunJson(rootDir);
    const summary = readFileSync(path.join(rootDir, document.run_dir as string, "summary.md"), "utf8");
    expect(summary).toContain(
      [
        "# nukadoko run failed: 6 criteria, 2 held, 1 proven, 1 removed, 1 unproven, 1 moved",
        "",
        `Compared with \`base-branch\` (\`${base.slice(0, 7)}\`): 2 unchanged, 1 changed, 2 new, 1 removed. The mapping changed (file \`features/steps/total-about.ts\`), so the old world ran each unchanged criterion under the base's steps.`,
        "",
        "| verdict | criterion | change | head default | base default | old default |",
        "| --- | --- | --- | --- | --- | --- |",
        "| held | `features/cart.feature:3` a cart with nothing in it | unchanged, renamed from `features/cart.feature` an empty cart | pass |  | pass |",
        "| moved | `features/cart.feature:7` three items | unchanged | pass |  | fail@9 |",
        "| proven | `features/cart.feature:11` five items | changed | pass | fail@13 (2 runs) |  |",
        "| held | `features/cart.feature:16` two items `@held` | new | pass | pass |  |",
        "| unproven | `features/cart.feature:20` four items | new | pass | pass |  |",
        "| removed | `features/cart.feature:15` gone soon | removed |  |  |  |",
        "",
        "- `features/cart.feature:7` three items: passes in default, but the mapping changed since the base, and a claim broke at line 9 of the base's feature file in the old world in default",
      ].join("\n"),
    );
    // The record's name carries the time it was written.
    expect(summary).toMatch(
      /\n  - old: step "the total is about 6": `claim broken: 7 \(from:a-cart@8\.total\) equal 6 \(sentence:expected\)`; record `steps\/step-[^`]+`\n- `features\/cart\.feature:20` four items: passes in default, and nothing shows a Then failing where its behaviour is absent \(base default: pass\)\n/,
    );
    expect(summary).toContain(
      [
        "## Removed criteria",
        "",
        "Each criterion below is in the base and not in head, quoted as the base has it.",
        "",
        "### `features/cart.feature:15` gone soon",
        "",
        "```gherkin",
        "Given a cart with 1 items",
        "Then the total is 2",
        "```",
      ].join("\n"),
    );
  });

  it("gives each unproven and moved row a finding whose do: line judges it again", async () => {
    const document = JSON.parse(result.stdout) as { findings: { severity: string; code: string; file?: string; line?: number; message: string; do?: string }[] };
    expect(document.findings.filter((finding) => finding.code.startsWith("criterion-"))).toEqual([
      {
        severity: "failed",
        code: "criterion-moved",
        file: "features/cart.feature",
        line: 7,
        message:
          'Scenario "three items" is moved: it passes in default, but the mapping changed since the base, and a claim broke at line 9 of the base\'s feature file in the old world in default',
        do: "nuka run features/cart.feature:7 --base base-branch",
      },
      {
        severity: "failed",
        code: "criterion-unproven",
        file: "features/cart.feature",
        line: 20,
        message: 'Scenario "four items" is unproven: it passes in default, and nothing shows a Then failing where its behaviour is absent (base default: pass)',
        do: "nuka run features/cart.feature:20 --base base-branch",
      },
    ]);
    const again = await cli(["run", "--json", ...document.findings.find((finding) => finding.code === "criterion-unproven")!.do!.split(" ").slice(2)]);
    expect(again.exitCode).toBe(1);
    expect((JSON.parse(again.stdout) as { table: { rows: Row[] } }).table.rows.filter((row) => row.line === 20).map((row) => row.verdict)).toEqual(["unproven"]);
  }, 60_000);

  it("refuses --since, naming --base", async () => {
    const refused = await cli(["run", "--since", "base-branch"]);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toBe(
      "refused\tremoved-flag\t-\tnuka run --since is removed: nuka run --base <ref> compares with the commit the ref names, runs a new or changed scenario where the base's code runs, and an unchanged one under the base's steps when they changed, and the verdict table says what each criterion came to.\n" +
        "  fix: Use what the message names in its place.\n" +
        "  do: nuka run --base base-branch\n",
    );
  });

  it("refuses a ref that names no commit", async () => {
    const refused = await cli(["run", "--json", "--base", "no-such-branch"]);
    expect(refused.exitCode).toBe(2);
    const envelope = JSON.parse(refused.stdout) as { findings: { code: string; message: string; do?: string }[] };
    expect(envelope.findings).toEqual([
      expect.objectContaining({ code: "base-ref-unknown", message: "--base no-such-branch names no commit in the project's repository", do: "git log --oneline" }),
    ]);
  });

  it("refuses a project outside git", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "nukadoko-base-outside-"));
    try {
      const refused = await cli(["run", "--json", "--base", "main"], outside);
      expect(refused.exitCode).toBe(2);
      const envelope = JSON.parse(refused.stdout) as { findings: { severity: string; code: string; message: string }[] };
      // The directory holds no config, which is a warning of its own.
      expect(envelope.findings.filter((finding) => finding.severity === "refused")).toEqual([
        expect.objectContaining({
          code: "base-outside-git",
          message: "nuka run --base main needs a git repository, and the project directory is not inside one",
        }),
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a shallow clone that lacks the base, with the fetch that gets it", async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "nukadoko-base-shallow-"));
    const clone = path.join(parent, "clone");
    try {
      execFileSync("git", ["clone", "-q", "--depth", "1", pathToFileURL(rootDir).href, clone]);
      const refused = await cli(["run", "--json", "--base", base], clone);
      expect(refused.exitCode).toBe(2);
      const envelope = JSON.parse(refused.stdout) as { findings: { code: string; message: string; do?: string }[] };
      expect(envelope.findings).toEqual([
        expect.objectContaining({
          code: "base-shallow",
          message: `--base ${base} names no commit in this shallow clone, which holds only part of the history; fetch the base first`,
          do: `git fetch --no-tags --depth=1 origin ${base}`,
        }),
      ]);
      expect(readdirSync(clone)).not.toContain(".nukadoko");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("nuka run --base, when the base's steps no longer load against head", () => {
  let rootDir: string;
  let result: { exitCode: number; stdout: string; stderr: string };

  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", rootDir, "-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { encoding: "utf8" }).trim();

  // Head moves the module the step imports, and the step with it; the
  // base's copy of the step still imports it from where it was.
  beforeAll(async () => {
    rootDir = await copyFixtureToTempDir("allure-identity-project");
    for (const file of ["nukadoko.program.ts", "features/checkout.feature", "features/steps/a-cart.ts", "features/steps/cart-holds.ts"]) {
      rmSync(path.join(rootDir, file));
    }
    writeFileSync(path.join(rootDir, "nukadoko-shim.ts"), `export * from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "src", "index.ts")).href)};\n`);
    writeFileSync(path.join(rootDir, ".gitignore"), ".nukadoko/\n");
    mkdirSync(path.join(rootDir, "lib"));
    writeFileSync(path.join(rootDir, "lib", "cart.mjs"), "export function total(count) {\n  return count * 2;\n}\n");
    writeFileSync(path.join(rootDir, "features", "cart.feature"), BASE_FEATURE);
    writeFileSync(path.join(rootDir, "features", "steps", "a-cart.ts"), STEP_A_CART);
    writeFileSync(path.join(rootDir, "features", "steps", "total-is.ts"), claimStep("the total is {expected:int}", "equal"));
    writeFileSync(path.join(rootDir, "features", "steps", "total-about.ts"), claimStep("the total is about {expected:int}", "equal"));
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("branch", "base-branch");
    git("mv", "lib/cart.mjs", "lib/prices.mjs");
    writeFileSync(path.join(rootDir, "features", "steps", "a-cart.ts"), STEP_A_CART.replace("../../lib/cart.mjs", "../../lib/prices.mjs"));
    git("add", "-A");
    git("commit", "-qm", "head");
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--base", "base-branch"], { rootDir, stdout, stderr });
    result = { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  }, 120_000);

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("calls every unchanged row moved, with the import that failed, named from the project root", () => {
    expect(result.exitCode).toBe(1);
    const rows = (latestRunJson(rootDir) as { table: { rows: Row[] } }).table.rows;
    expect(rows.map((row) => [row.name, row.change, row.verdict])).toEqual([
      ["an empty cart", "unchanged", "moved"],
      ["three items", "unchanged", "moved"],
      ["five items", "unchanged", "moved"],
      ["gone soon", "unchanged", "moved"],
    ]);
    for (const row of rows) {
      const old = row.cells.find((cell) => cell.world === "old");
      expect(old).toMatchObject({ outcome: "not-run" });
      expect(old?.reason).toMatch(/^nuka check reports \d+ errors? in the old tree, the first step-file-import-failed at features\/steps\/a-cart\.ts: .*lib\/cart\.mjs/);
      expect(old?.reason).not.toContain(rootDir);
    }
    // stderr says it once, where the count line shows the red rows.
    const notRun = result.stderr.split("\n").filter((line) => line.startsWith("old default  not run: "));
    expect(notRun).toEqual([`old default  not run: ${rows[0]!.cells.find((cell) => cell.world === "old")!.reason}`]);
    // And each moved row is a finding after the count line, with a do: line.
    expect(result.stderr).toContain("failed\tcriterion-moved\tfeatures/cart.feature:3\tScenario \"an empty cart\" is moved: it passes in default, but the mapping changed since the base, and it did not run in the old world in default: ");
    expect(result.stderr).toContain("  do: nuka run features/cart.feature:3 --base base-branch\n");
  });
});

describe("nuka run --base, with a program file at the base and at head", () => {
  let rootDir: string;
  let result: { exitCode: number; stdout: string; stderr: string };

  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", rootDir, "-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { encoding: "utf8" }).trim();

  // Every world runs a prepare command that names its directory, so its
  // progress line shows how a tree's path is printed. The environment
  // `unused` names {port} and has neither serve nor url, which `nuka check`
  // reports only for a run that starts it: this one starts `default` alone,
  // at head and in both trees.
  const PROGRAM = `import { defineProgram } from "./nukadoko-shim.js";

export default defineProgram({
  prepare: [["node", "-e", "", "{dir}"]],
  environments: {
    unused: { env: { WHERE: "{port}" } },
  },
});
`;

  beforeAll(async () => {
    rootDir = await copyFixtureToTempDir("allure-identity-project");
    for (const file of ["features/checkout.feature", "features/steps/a-cart.ts", "features/steps/cart-holds.ts"]) {
      rmSync(path.join(rootDir, file));
    }
    writeFileSync(path.join(rootDir, "nukadoko.program.ts"), PROGRAM);
    writeFileSync(path.join(rootDir, "nukadoko-shim.ts"), `export * from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "src", "index.ts")).href)};\n`);
    writeFileSync(path.join(rootDir, ".gitignore"), ".nukadoko/\n");
    mkdirSync(path.join(rootDir, "lib"));
    writeFileSync(path.join(rootDir, "lib", "cart.mjs"), "export function total(count) {\n  return count * 2;\n}\n");
    writeFileSync(path.join(rootDir, "features", "cart.feature"), "Feature: Cart\n\n  Scenario: an empty cart\n    Given a cart with 0 items\n    Then the total is 0\n");
    writeFileSync(path.join(rootDir, "features", "steps", "a-cart.ts"), STEP_A_CART);
    writeFileSync(path.join(rootDir, "features", "steps", "total-is.ts"), claimStep("the total is {expected:int}", "equal"));
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("branch", "base-branch");
    // Head: a discount from five items, a criterion for it, and a data file
    // under the features directory, which changes the mapping.
    writeFileSync(path.join(rootDir, "lib", "cart.mjs"), "export function total(count) {\n  return count >= 5 ? count * 2 - 1 : count * 2;\n}\n");
    writeFileSync(
      path.join(rootDir, "features", "cart.feature"),
      "Feature: Cart\n\n  Scenario: an empty cart\n    Given a cart with 0 items\n    Then the total is 0\n\n  Scenario: five items\n    Given a cart with 5 items\n    Then the total is 9\n",
    );
    mkdirSync(path.join(rootDir, "features", "data"));
    writeFileSync(path.join(rootDir, "features", "data", "discount.json"), '{ "from": 5 }\n');
    git("add", "-A");
    git("commit", "-qm", "head");
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--base", "base-branch"], { rootDir, stdout, stderr });
    result = { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  }, 120_000);

  afterAll(async () => {
    await removeTempDir(rootDir);
  });

  it("checks the placeholders of only the worlds each tree starts, and names a tree's paths from the project root", () => {
    expect(result.exitCode).toBe(0);
    const document = latestRunJson(rootDir) as { run_dir: string; table: { rows: Row[] } };
    expect(document.table.rows.map((row) => [row.name, row.change, row.verdict, row.cells.map((cell) => `${cell.world}:${cell.outcome}`)])).toEqual([
      ["an empty cart", "unchanged", "held", ["head:pass", "old:pass"]],
      ["five items", "new", "proven", ["head:pass", "base:fail"]],
    ]);
    const prepared = result.stderr.split("\n").filter((line) => line.includes("prepare started: "));
    expect(prepared.filter((line) => line.startsWith("world default (base): ") || line.startsWith("world default (old): ")).sort()).toEqual([
      `world default (base): prepare started: node -e '' ${document.run_dir}/worlds/default@base`,
      `world default (old): prepare started: node -e '' ${document.run_dir}/worlds/default@old`,
    ]);
  });
});
