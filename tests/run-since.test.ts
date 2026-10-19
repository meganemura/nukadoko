import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run --since <ref>` on a real git history: one
// scenario unchanged (re-indented only), one changed, one new, and one
// step file changed, read back from run.json, the --json document, and
// the summary; removed criteria and what was compared; tags; a ref file
// that does not parse; step files as git compares them, untracked ones,
// parts, and fixtures; the run without --since; and the refusals,
// including a missing git binary.

const BASE = `Feature: Checkout

  Scenario: an empty cart
    Given a cart with 0 items
    Then the cart holds 0 items

  Scenario: a full cart
    Given a cart with 5 items
    Then the cart holds 5 items
`;

const NOW = `Feature: Checkout

    Scenario: an empty cart
      Given a cart with 0 items
      Then the cart holds 0 items

  Scenario: a full cart
    Given a cart with 6 items
    Then the cart holds 6 items

  Scenario: a big cart
    Given a cart with 9 items
    Then the cart holds 9 items
`;

interface Document {
  verdict: string;
  since: {
    ref: string;
    commit: string;
    compared: string[];
    removed: { feature: string; rule: string | null; scenario: string; lines: string[] }[];
    step_files: { file: string; change: string }[];
  } | null;
  scenarios: { scenario: string; criteria: { changed_since: string | null; reason?: string; lines?: string[]; step_files?: string[] } }[];
}

describe("nuka run --since", () => {
  let rootDir: string;
  let base: string;

  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", rootDir, "-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { encoding: "utf8" }).trim();

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("allure-identity-project");
    writeFileSync(path.join(rootDir, "features", "checkout.feature"), BASE);
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "base");
    base = git("rev-parse", "HEAD");
    writeFileSync(path.join(rootDir, "features", "checkout.feature"), NOW);
    appendFileSync(path.join(rootDir, "features", "steps", "cart-holds.ts"), "// edited after the base\n");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  async function cli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(args, { rootDir, stdout, stderr });
    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  }

  it("classifies each scenario's criteria and each bound step file against the ref, and reports only", async () => {
    const result = await cli(["run", "--json", "--since", "HEAD"]);
    expect(result.exitCode).toBe(0);
    const document = JSON.parse(result.stdout) as Document;
    const stepFiles = ["features/steps/a-cart.ts", "features/steps/cart-holds.ts"];
    expect(document.since).toEqual({
      ref: "HEAD",
      commit: base,
      compared: ["features"],
      removed: [],
      step_files: [
        { file: "features/steps/a-cart.ts", change: "unchanged" },
        { file: "features/steps/cart-holds.ts", change: "changed" },
      ],
    });
    expect(document.scenarios.map((scenario) => [scenario.scenario, scenario.criteria])).toEqual([
      ["an empty cart", { changed_since: "unchanged", step_files: stepFiles }],
      ["a full cart", { changed_since: "changed", lines: ["Given a cart with 6 items", "Then the cart holds 6 items"], step_files: stepFiles }],
      ["a big cart", { changed_since: "new", lines: ["Given a cart with 9 items", "Then the cart holds 9 items"], step_files: stepFiles }],
    ]);
    const [runId] = readdirSync(path.join(rootDir, ".nukadoko", "runs"));
    const runJson = JSON.parse(readFileSync(path.join(rootDir, ".nukadoko", "runs", runId!, "run.json"), "utf8")) as Document;
    expect(runJson.since).toEqual(document.since);
    const summary = readFileSync(path.join(rootDir, ".nukadoko", "runs", runId!, "summary.md"), "utf8");
    expect(summary).toContain(
      [
        `## Criteria since \`HEAD\` (\`${base.slice(0, 7)}\`)`,
        "",
        "1 unchanged, 1 changed, 1 new, 0 removed.",
        "Compared: the feature files in `features` at the ref and in the working tree; a feature file outside them is not compared.",
        "Step files compared: the files that register the bound steps, the files of their parts, and the config file when a step needs a fixture it defines, not the files those import.",
        "Step files changed: `features/steps/cart-holds.ts`.",
        "",
        "### Changed: `features/checkout.feature:7` a full cart",
        "",
        "```gherkin",
        "Given a cart with 6 items",
        "Then the cart holds 6 items",
        "```",
        "",
        "### New: `features/checkout.feature:11` a big cart",
        "",
        "```gherkin",
        "Given a cart with 9 items",
        "Then the cart holds 9 items",
        "```",
        "",
        "### Step file changed: `features/steps/cart-holds.ts`",
        "",
        "- `features/checkout.feature:3` an empty cart, criteria unchanged",
        "- `features/checkout.feature:7` a full cart, criteria changed",
        "- `features/checkout.feature:11` a big cart, criteria new",
        "",
        "## features/checkout.feature",
      ].join("\n"),
    );
    const markdown = await cli(["report", "--format", "markdown"]);
    expect(markdown.stdout).toBe(summary);
  });

  it("gives every scenario criteria with changed_since null and the run since null without the flag", async () => {
    const result = await cli(["run", "--json"]);
    expect(result.exitCode).toBe(0);
    const document = JSON.parse(result.stdout) as Document;
    expect(document.since).toBeNull();
    expect(document.scenarios.map((scenario) => scenario.criteria)).toEqual([{ changed_since: null }, { changed_since: null }, { changed_since: null }]);
  });

  it("lists a criterion the working tree dropped and a feature file it deleted as removed, and compares only the named file", async () => {
    git("checkout", "--", ".");
    writeFileSync(path.join(rootDir, "features", "gone.feature"), "Feature: Gone\n\n  Scenario: a lost cart\n    Given a cart with 1 items\n");
    git("add", "-A");
    git("commit", "-qm", "with gone");
    rmSync(path.join(rootDir, "features", "gone.feature"));
    writeFileSync(path.join(rootDir, "features", "checkout.feature"), BASE.replace(/\n  Scenario: a full cart[\s\S]*$/, "\n"));
    const all = JSON.parse((await cli(["run", "--json", "--since", "HEAD"])).stdout) as Document;
    expect(all.since!.compared).toEqual(["features"]);
    expect(all.since!.removed).toEqual([
      { feature: "features/checkout.feature", rule: null, scenario: "a full cart", lines: ["Given a cart with 5 items", "Then the cart holds 5 items"] },
      { feature: "features/gone.feature", rule: null, scenario: "a lost cart", lines: ["Given a cart with 1 items"] },
    ]);
    const [runId] = readdirSync(path.join(rootDir, ".nukadoko", "runs"));
    const summary = readFileSync(path.join(rootDir, ".nukadoko", "runs", runId!, "summary.md"), "utf8");
    expect(summary).toContain("1 unchanged, 0 changed, 0 new, 2 removed.");
    expect(summary).toContain(["### Removed: `features/gone.feature` a lost cart", "", "```gherkin", "Given a cart with 1 items", "```"].join("\n"));
    const named = JSON.parse((await cli(["run", "--json", "--since", "HEAD", "features/checkout.feature"])).stdout) as Document;
    expect(named.since!.compared).toEqual(["features/checkout.feature"]);
    expect(named.since!.removed.map((removed) => removed.scenario)).toEqual(["a full cart"]);
  });

  it("counts a tag added to a scenario as a change", async () => {
    writeFileSync(path.join(rootDir, "features", "checkout.feature"), BASE.replace("  Scenario: an empty cart", "  @slow\n  Scenario: an empty cart"));
    const document = JSON.parse((await cli(["run", "--json", "--since", "HEAD"])).stdout) as Document;
    expect(document.scenarios.map((scenario) => [scenario.scenario, scenario.criteria.changed_since])).toEqual([
      ["an empty cart", "changed"],
      ["a full cart", "unchanged"],
    ]);
  });

  it("tells a table cell that holds a pipe from two cells, and matches two scenarios of one name by content, not position", async () => {
    git("checkout", "--", ".");
    const of = (cell: string, first: string, second: string) =>
      `Feature: Checkout\n\n  Scenario: a table\n    Given a cart with 1 items\n      ${cell}\n\n  Scenario: twin\n    Given a cart with ${first} items\n\n  Scenario: twin\n    Given a cart with ${second} items\n`;
    writeFileSync(path.join(rootDir, "features", "checkout.feature"), of("| a \\| b |", "1", "2"));
    git("add", "-A");
    git("commit", "-qm", "table and twins");
    writeFileSync(path.join(rootDir, "features", "checkout.feature"), of("| a | b |", "2", "1"));
    const document = JSON.parse((await cli(["run", "--no-check", "--json", "--since", "HEAD"])).stdout) as Document;
    expect(document.scenarios.map((scenario) => [scenario.scenario, scenario.criteria.changed_since])).toEqual([
      ["a table", "changed"],
      ["twin", "unchanged"],
      ["twin", "unchanged"],
    ]);
  });

  it("says a scenario cannot be compared when its file does not parse at the ref, never that it is new", async () => {
    git("checkout", "--", ".");
    writeFileSync(path.join(rootDir, "features", "checkout.feature"), "  Given a step outside any feature\n");
    git("add", "-A");
    git("commit", "-qm", "broken");
    writeFileSync(path.join(rootDir, "features", "checkout.feature"), BASE);
    const document = JSON.parse((await cli(["run", "--json", "--since", "HEAD"])).stdout) as Document;
    expect(document.scenarios.map((scenario) => scenario.criteria.changed_since)).toEqual(["unknown", "unknown"]);
    expect(document.scenarios[0]!.criteria.reason).toBe(
      "features/checkout.feature does not parse at the ref ((1:3): expected: #EOF, #Language, #TagLine, #FeatureLine, #Comment, #Empty, got 'Given a step outside any feature'), so its criteria cannot be compared",
    );
  });

  it("compares a step file as git does, calls one the ref lacks untracked, and names part and fixture files", async () => {
    git("checkout", "--", ".");
    writeFileSync(path.join(rootDir, ".gitattributes"), "* text=auto\n");
    git("add", "-A");
    git("commit", "-qm", "attributes");
    const commit = git("rev-parse", "HEAD");
    appendFileSync(path.join(rootDir, "features", "steps", "cart-holds.ts"), "// edited after the base\n");
    // Line endings only: git's own comparison sees no change.
    const cart = path.join(rootDir, "features", "steps", "a-cart.ts");
    writeFileSync(cart, readFileSync(cart, "utf8").replaceAll("\n", "\r\n"));
    writeFileSync(
      path.join(rootDir, "features", "steps", "count-part.ts"),
      'import { z } from "zod";\nimport { defineStep } from "../../nukadoko-shim.js";\n\nexport default defineStep({\n  description: "Counts",\n  args: z.object({}),\n  returns: z.object({}),\n  mutates: false,\n  async run() {\n    return {};\n  },\n});\n',
    );
    writeFileSync(
      path.join(rootDir, "features", "steps", "a-tenant.ts"),
      'import { z } from "zod";\nimport { defineStep } from "../../nukadoko-shim.js";\nimport countPart from "./count-part.js";\n\nexport default defineStep({\n  pattern: "a tenant",\n  description: "Uses the tenant fixture and a part",\n  args: z.object({}),\n  returns: z.object({}),\n  mutates: false,\n  parts: [countPart],\n  async run({ tenant, call }: any) {\n    await call(countPart, {});\n    return { id: tenant.id };\n  },\n});\n',
    );
    const config = path.join(rootDir, "nukadoko.config.ts");
    writeFileSync(
      config,
      readFileSync(config, "utf8")
        .replace('import { defineConfig } from "./nukadoko-shim.js";', 'import { defineConfig, defineFixtures } from "./nukadoko-shim.js";')
        .replace("export default defineConfig({", "export default defineConfig({\n  fixtures: defineFixtures({ tenant: async ({}, use) => { await use({ id: \"t1\" }); } }),"),
    );
    writeFileSync(path.join(rootDir, "features", "checkout.feature"), `${BASE}\n  Scenario: a tenant\n    Given a tenant\n`);
    const result = await cli(["run", "--json", "--since", commit]);
    expect(result.exitCode).toBe(0);
    const document = JSON.parse(result.stdout) as Document;
    expect(document.since!.step_files).toEqual([
      { file: "features/steps/a-cart.ts", change: "unchanged" },
      { file: "features/steps/a-tenant.ts", change: "untracked" },
      { file: "features/steps/cart-holds.ts", change: "changed" },
      { file: "features/steps/count-part.ts", change: "untracked" },
      { file: "nukadoko.config.ts", change: "changed" },
    ]);
    expect(document.scenarios.at(-1)!.criteria.step_files).toEqual(["features/steps/a-tenant.ts", "features/steps/count-part.ts", "nukadoko.config.ts"]);
  });

  it("refuses a ref that names no commit, and runs nothing", async () => {
    expect(await cli(["run", "--since", "no-such-branch"])).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "refused\tsince-ref-unknown\t-\t--since no-such-branch names no commit in the project's repository\n  fix: Name a branch, tag, or commit the repository holds, such as the base the criteria were approved at. In CI, fetch it first: git fetch origin <base branch>, or fetch-depth: 0 on actions/checkout.\n  do: git log --oneline\n",
    });
    expect(readdirSync(rootDir)).not.toContain(".nukadoko");
  });
});

describe("nuka run --since outside git", () => {
  let rootDir: string;
  beforeEach(() => {
    rootDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-since-"));
  });
  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("refuses with since-git-failed, not since-outside-git, when git itself is missing", async () => {
    const before = process.env.PATH;
    process.env.PATH = rootDir;
    const stdout = createCaptureSink();
    let exitCode: number;
    try {
      exitCode = await runCli(["run", "--json", "--since", "main"], { rootDir, stdout, stderr: createCaptureSink() });
    } finally {
      process.env.PATH = before;
    }
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout.text()) as { findings: { code: string; message: string }[] };
    expect(envelope.findings.at(-1)).toMatchObject({
      code: "since-git-failed",
      message: "nuka run --since main could not ask git where the project is: git rev-parse --is-inside-work-tree failed: git is not installed, or not on PATH",
    });
  });

  it("refuses with since-outside-git", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "--json", "--since", "main"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout.text()) as { verdict: string; findings: { code: string; message: string }[] };
    expect(envelope.verdict).toBe("refused");
    expect(envelope.findings.at(-1)).toMatchObject({
      code: "since-outside-git",
      message: "nuka run --since main needs a git repository, and the project directory is not inside one",
    });
  });
});
