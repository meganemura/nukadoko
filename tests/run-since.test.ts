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
// the summary; the run without --since; and the two refusals.

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
  since: { ref: string; commit: string; step_files: { file: string; changed: boolean }[] } | null;
  scenarios: { scenario: string; criteria: { changed_since: string | null; lines?: string[]; step_files?: string[] } }[];
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
      step_files: [
        { file: "features/steps/a-cart.ts", changed: false },
        { file: "features/steps/cart-holds.ts", changed: true },
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
        "1 unchanged, 1 changed, 1 new.",
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

  it("refuses a ref that names no commit, and runs nothing", async () => {
    expect(await cli(["run", "--since", "no-such-branch"])).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "refused\tsince-ref-unknown\t-\t--since no-such-branch names no commit in the project's repository\n  do: git log --oneline\n",
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
