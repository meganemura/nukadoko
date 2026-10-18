import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, createEmptyTempDir, fixture, removeTempDir, withoutNoConfigLine } from "./helpers/fixtures.js";

describe("removed flags", () => {
  it("refuses nuka run --quiet and names --json in its place", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/x.feature", "--quiet"], { rootDir: fixture("basic-project"), stdout, stderr });

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe(
      "refused\tremoved-command\t-\tnuka run --quiet is removed: nuka run --json prints one document on stdout and nothing on stderr.\n" +
        "  fix: Use what the message names in its place.\n  do: nuka run --help\n",
    );
  });

  it("refuses nuka run --summary and names nuka report in its place", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/x.feature", "--summary", "out.md"], { rootDir: fixture("basic-project"), stdout, stderr });

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe(
      "refused\tremoved-command\t-\tnuka run --summary is removed: nuka report --format markdown --out <path> writes the run " +
        "summary of the newest run to a path.\n" +
        "  fix: Use what the message names in its place.\n  do: nuka run --help\n",
    );
  });

  it("refuses nuka do --session and names a fixture in its place", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "step", "--args", "{}", "--session", "alice"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe(
      "refused\tremoved-command\t-\tnuka do --session is removed: each nuka do call starts clean. A step that needs login state " +
        "gets it from a fixture, and a page whose state cannot be repeated is explored through a Playwright MCP server.\n" +
        "  fix: Use what the message names in its place.\n  do: nuka do --help\n",
    );
  });
});

describe("Markdown oaths, removed", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("refuses a config that still sets oaths, with config-key-removed", async () => {
    await writeFile(path.join(rootDir, "nukadoko.config.ts"), 'export default { oaths: ["docs/*.md"] };\n');
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toBe("");
    const findings = (JSON.parse(stdout.text()) as { findings: { code: string; message: string; fix: string }[] }).findings;
    expect(findings.map((finding) => finding.code)).toEqual(["config-key-removed"]);
    expect(findings[0]!.message).toBe(
      `Invalid config at ${path.join(rootDir, "nukadoko.config.ts")}: oaths was removed: nukadoko reads scenarios from .feature files only. ` +
        "Write each Markdown oath as a .feature file under featuresDir.",
    );
    expect(findings[0]!.fix).toBe("Remove oaths from nukadoko.config.ts.");
  });

  it("refuses a .md target by name", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/x.md"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(withoutNoConfigLine(stderr.text())).toBe(
      "refused\tremoved-command\t-\tfeatures/x.md is a Markdown file: Markdown oaths were removed, and nukadoko reads scenarios " +
        "from .feature files only\n" +
        "  fix: Write the scenarios of features/x.md as Gherkin in a .feature file, and name that file.\n",
    );
  });
});

describe("run-time emitters, removed", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("refuses a config that still sets allure and messages, naming nuka report for each", async () => {
    await writeFile(path.join(rootDir, "nukadoko.config.ts"), 'export default { allure: {}, messages: { output: "m.ndjson" } };\n');
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toBe("");
    const findings = (JSON.parse(stdout.text()) as { findings: { code: string; message: string; fix: string }[] }).findings;
    expect(findings.map((finding) => finding.code)).toEqual(["config-key-removed"]);
    expect(findings[0]!.message).toBe(
      `Invalid config at ${path.join(rootDir, "nukadoko.config.ts")}: allure was removed: nuka run writes no Allure results. ` +
        "Run nuka report --format allure after a run; it writes <stateDir>/export/allure-results, or the directory --out names. " +
        "messages was removed: nuka run writes no cucumber-messages stream. Run nuka report --format messages --out <path> after a run.",
    );
    expect(findings[0]!.fix).toBe("Remove allure and messages from nukadoko.config.ts.");
  });
});
