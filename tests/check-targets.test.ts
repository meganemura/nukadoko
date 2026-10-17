import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka check [target..]` selects files the way `nuka run`
// does: several files, a directory walked for .feature files, or both.
// check-feature-arg-project has one project-wide finding (a step whose
// pattern names an unknown parameter type), which every target reports
// once, and one undefined step in each of acceptance/outside.feature and
// features/inside.feature. Each undefined-step message ends by naming
// unknown-type-step, whose pattern never builds and so binds no line.

const UNBOUND =
  '; patterned steps no scanned feature line binds: unknown-type-step ("an unknown type {value:frobnicate} thing", features/steps/unknown-type-step.ts)';
const PROJECT_WIDE = "error\tunknown-parameter-type\tfeatures/steps/unknown-type-step.ts\t";
const PROJECT_WIDE_DO = "  do: Register the type in config.parameterTypes, or use a built-in type such as {key:string}.";
const OUTSIDE =
  "error\tundefined-step\tacceptance/outside.feature:4\t" +
  'No step definition matches "this step is undefined outside featuresDir"; run `nuka scaffold --feature acceptance/outside.feature` to add one' + UNBOUND;
const OUTSIDE_DO = "  do: nuka scaffold --feature acceptance/outside.feature";
const INSIDE =
  "error\tundefined-step\tfeatures/inside.feature:4\t" +
  'No step definition matches "this step is undefined inside featuresDir"; run `nuka scaffold --feature features/inside.feature` to add one' + UNBOUND;
const INSIDE_DO = "  do: nuka scaffold --feature features/inside.feature";
const EXTRA =
  "error\tundefined-step\tacceptance/nested/extra.feature:4\t" +
  'No step definition matches "this step is undefined in a nested file"; run `nuka scaffold --feature acceptance/nested/extra.feature` to add one' + UNBOUND;
const EXTRA_DO = "  do: nuka scaffold --feature acceptance/nested/extra.feature";

async function check(rootDir: string, argv: string[]) {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["check", ...argv], { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

/** The report lines with the project-wide finding's long message cut to its
 * prefix, so each assertion can list the whole report literally. */
function reportLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (line.startsWith(PROJECT_WIDE) ? PROJECT_WIDE : line));
}

describe("nuka check [target..]", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("check-feature-arg-project");
    await mkdir(path.join(rootDir, "acceptance", "nested"));
    await writeFile(
      path.join(rootDir, "acceptance", "nested", "extra.feature"),
      "Feature: Nested\n\n  Scenario: nested\n    Given this step is undefined in a nested file\n",
    );
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("walks a directory for every .feature file under it", async () => {
    const result = await check(rootDir, ["acceptance"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(reportLines(result.stdout)).toEqual([PROJECT_WIDE, PROJECT_WIDE_DO, EXTRA, EXTRA_DO, OUTSIDE, OUTSIDE_DO]);
  });

  it("checks two files together", async () => {
    const result = await check(rootDir, ["features/inside.feature", "acceptance/outside.feature"]);

    expect(result.exitCode).toBe(1);
    expect(reportLines(result.stdout)).toEqual([PROJECT_WIDE, PROJECT_WIDE_DO, OUTSIDE, OUTSIDE_DO, INSIDE, INSIDE_DO]);
  });

  it("checks a file plus a directory, and a file inside that directory once", async () => {
    const result = await check(rootDir, ["features/inside.feature", "acceptance", "acceptance/outside.feature"]);

    expect(result.exitCode).toBe(1);
    expect(reportLines(result.stdout)).toEqual([
      PROJECT_WIDE,
      PROJECT_WIDE_DO,
      EXTRA,
      EXTRA_DO,
      OUTSIDE,
      OUTSIDE_DO,
      INSIDE,
      INSIDE_DO,
    ]);
  });

  it("refuses an unknown path among known ones with one error that names it, and no report", async () => {
    const result = await check(rootDir, ["acceptance", "acceptance/missing.feature"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("nuka check: feature file not found: acceptance/missing.feature\n");
  });

  it("refuses :line on a file named among other targets", async () => {
    const result = await check(rootDir, ["features", "acceptance/outside.feature:4"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "nuka check: acceptance/outside.feature:4: :line is not supported; " +
        "check analyzes the whole file, not one scenario. Run: nuka check acceptance/outside.feature\n",
    );
  });

  it("reports a file in a directory target that does not parse as a finding beside the others", async () => {
    await writeFile(path.join(rootDir, "acceptance", "broken.feature"), "Feature: Broken\n\n  Scenario: uneven table\n    Given a table\n      | a | b |\n      | 1 |\n");
    const result = await check(rootDir, ["--json", "acceptance"]);

    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as { errors: { code: string; file?: string }[] };
    expect(report.errors.map((issue) => [issue.code, issue.file])).toEqual([
      ["unknown-parameter-type", "features/steps/unknown-type-step.ts"],
      ["feature-parse-error", "acceptance/broken.feature"],
      ["undefined-step", "acceptance/nested/extra.feature"],
      ["undefined-step", "acceptance/outside.feature"],
    ]);
  });

  it("keeps the --json report shape a no-target check prints", async () => {
    const targeted = JSON.parse((await check(rootDir, ["--json", "acceptance", "features"])).stdout) as object;
    const whole = JSON.parse((await check(rootDir, ["--json"])).stdout) as object;

    expect(Object.keys(targeted)).toEqual(["schema_version", "errors", "warnings"]);
    expect(Object.keys(targeted)).toEqual(Object.keys(whole));
    expect((targeted as { errors: { code: string; file?: string; line?: number }[] }).errors[2]).toEqual({
      code: "undefined-step",
      message:
        'No step definition matches "this step is undefined outside featuresDir"; run `nuka scaffold --feature acceptance/outside.feature` to add one' +
        UNBOUND,
      file: "acceptance/outside.feature",
      line: 4,
      do: "nuka scaffold --feature acceptance/outside.feature",
    });
  });
});
