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
//
// The fixture accepts the same browser-touching scenario twice, once inside
// `featuresDir` ("features/inside.feature") and once outside it
// ("elsewhere/outside.feature"): src/tend/signoff-condition-mismatch.ts
// skips this note entirely for a record whose feature lives inside
// `featuresDir` (that file's own header — the same placement skip
// src/tend/signoff-rot.ts applies, for the same reason), so a single fixture
// with one accepted feature on each side of that line is what proves both
// "fires" and "stays silent" against the same mismatch.

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
      `export default defineConfig({ browserType: "${browserType}" });`,
      "",
    ].join("\n"),
  );
}

describe("nuka tend: signoff-condition-mismatch", () => {
  let rootDir: string;
  let insideRecordPath: string;
  let outsideRecordPath: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("signoff-condition-mismatch-project");
    await initGitRepo(rootDir);

    for (const featurePath of ["features/inside.feature", "elsewhere/outside.feature"]) {
      const runExit = await runCli(["run", featurePath], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      });
      expect(runExit).toBe(0);

      const acceptStdout = createCaptureSink();
      const acceptExit = await runCli(["accept", featurePath], {
        rootDir,
        stdout: acceptStdout,
        stderr: createCaptureSink(),
      });
      expect(acceptExit).toBe(0);
      if (featurePath === "features/inside.feature") {
        insideRecordPath = acceptStdout.text().trim();
      } else {
        outsideRecordPath = acceptStdout.text().trim();
      }
    }
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("reports nothing when the config's browserType still matches both sign-offs' own recorded browser", async () => {
    const report = await runTend(rootDir);
    expect(report.notes.filter((n) => n.code === "signoff-condition-mismatch")).toEqual([]);
  });

  it("reports a mismatch for the feature outside featuresDir once the config's browserType diverges, and stays silent for the one inside", async () => {
    await writeConfig(rootDir, "firefox");

    const report = await runTend(rootDir);
    const mismatches = report.notes.filter((n) => n.code === "signoff-condition-mismatch");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.file).toBe(outsideRecordPath);
    expect(mismatches[0]!.message).toContain('"chromium"');
    expect(mismatches[0]!.message).toContain('"firefox"');
    // The feature inside featuresDir now runs unattended on every `nuka
    // run`, so its own sign-off's condition drifting is not reported at all
    // — never present under a different message, absent entirely.
    expect(mismatches.map((m) => m.file)).not.toContain(insideRecordPath);
  });

  it("never reports a mismatch for a record accepted before this task shipped (no condition to compare)", async () => {
    // Hand-crafted, same shape signoff-rot.test.ts's own synthetic records
    // use — frontmatter with no `browser:` line at all, the exact shape
    // every record accepted before this task ever produced. Placed under
    // `elsewhere/`, outside featuresDir, so the only reason it stays silent
    // is the condition being unknown, not the separate featuresDir skip
    // this file's own header describes.
    await writeFile(
      path.join(rootDir, "elsewhere", "old.2020-01-01-0000000.md"),
      [
        "---",
        "run_id: run-old",
        "commit: " + "0".repeat(40),
        "feature: elsewhere/old.feature",
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
    // The real, condition-carrying record for elsewhere/outside.feature
    // still reports (proving this isn't a vacuous pass); the hand-crafted
    // condition-unknown one for elsewhere/old.feature must not appear at
    // all, and neither must the one inside featuresDir.
    expect(mismatches.map((m) => m.file)).toEqual([outsideRecordPath]);
  });
});
