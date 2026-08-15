import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka tend`'s `signoff-condition-mismatch` note end to
// end — the one tend finding
// that reads a sign-off's own recorded condition against the *current*
// config, unrelated to src/tend/signoff-rot.ts's own staleness checks
// (it isn't wrong at this exact moment, so a `note`,
// never an `error`). `nuka tend` never checks git state at all (unlike
// `nuka accept`), so a config edit here is never committed — only `nuka
// accept` itself, further down, needs a clean tree.

interface Report {
  errors: { code: string }[];
  notes: { code: string; message: string; file?: string }[];
}

async function runTend(rootDir: string): Promise<Report> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["tend", "--json"], { rootDir, stdout, stderr });
  expect(stderr.text()).toBe("");
  expect(exitCode).toBe(0); // This note never sets tend's own exit code (it is a note, not an error).
  return JSON.parse(stdout.text()) as Report;
}

function writeConfig(rootDir: string, browserType: string): Promise<void> {
  return writeFile(
    path.join(rootDir, "nukadoko.config.ts"),
    [
      'import { defineConfig } from "./nukadoko-shim.js";',
      `export default defineConfig({ environments: { staging: {} }, browserType: "${browserType}" });`,
      "",
    ].join("\n"),
  );
}

describe("nuka tend: signoff-condition-mismatch", () => {
  let rootDir: string;
  let recordPath: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-condition-project");
    await initGitRepo(rootDir);

    const runExit = await runCli(["run", "features/browser.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    const acceptStdout = createCaptureSink();
    const acceptExit = await runCli(["accept", "features/browser.feature"], {
      rootDir,
      stdout: acceptStdout,
      stderr: createCaptureSink(),
    });
    expect(acceptExit).toBe(0);
    recordPath = acceptStdout.text().trim();
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("reports nothing when the config's browserType still matches the latest sign-off's own recorded browser", async () => {
    const report = await runTend(rootDir);
    expect(report.notes.filter((n) => n.code === "signoff-condition-mismatch")).toEqual([]);
  });

  it("reports a mismatch once the config's browserType diverges from the latest sign-off's own recorded browser", async () => {
    await writeConfig(rootDir, "firefox");

    const report = await runTend(rootDir);
    const mismatches = report.notes.filter((n) => n.code === "signoff-condition-mismatch");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.file).toBe(recordPath);
    expect(mismatches[0]!.message).toContain('"chromium"');
    expect(mismatches[0]!.message).toContain('"firefox"');
  });

  it("never reports a mismatch for a record accepted before this task shipped (no condition to compare)", async () => {
    // Hand-crafted, same shape signoff-rot.test.ts's own synthetic records
    // use — frontmatter with no `browser:` line at all, the exact shape
    // every record accepted before this task ever produced.
    await writeFile(
      path.join(rootDir, "features", "old.2020-01-01-0000000.md"),
      [
        "---",
        "run_id: run-old",
        "commit: " + "0".repeat(40),
        "feature: features/old.feature",
        "ran_at: 2020-01-01T00:00:00.000+00:00",
        "accepted_at: 2020-01-01T00:00:00.000+00:00",
        "environment: default",
        "scenarios:",
        "  - name: an old scenario",
        "    line: 2",
        "    scenario_id: scn-old",
        "---",
        "",
        "# Old: green at 0000000",
        "",
        "## The scenario as it ran",
        "",
        "```gherkin",
        "Feature: Old",
        "  Scenario: an old scenario",
        "    Given something happened",
        "```",
        "",
      ].join("\n"),
    );
    await writeConfig(rootDir, "firefox");

    const report = await runTend(rootDir);
    const mismatches = report.notes.filter((n) => n.code === "signoff-condition-mismatch");
    // The real, condition-carrying record for features/browser.feature still
    // reports (proving this isn't a vacuous pass); the hand-crafted
    // condition-unknown one for features/old.feature must not appear at all.
    expect(mismatches.map((m) => m.file)).toEqual([recordPath]);
  });
});
