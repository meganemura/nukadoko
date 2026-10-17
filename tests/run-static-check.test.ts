import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run` performs the static check before it executes,
// `--no-check` skips it, and `nuka run` with no target runs featuresDir.
// run-check-project has one mutating step and one read-only step, so a
// feature can be clean, bind a mutating step in Then position, or name no
// step at all.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

function errorLines(text: string): string[] {
  return nonEmptyLines(text).filter((line) => line.startsWith("error\t"));
}

async function run(rootDir: string, argv: string[]) {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(argv, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

function scenarioOutcomes(stdout: string): Array<[string, string, string]> {
  return nonEmptyLines(stdout).map((line) => {
    const record = JSON.parse(line) as { feature: string; scenario: string; status: string };
    return [record.feature, record.scenario, record.status];
  });
}

describe("nuka run checks before it executes", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-check-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("refuses a feature with an undefined step: exit 1, the check finding on stderr, no record written", async () => {
    const result = await run(rootDir, ["run", "features/mixed.feature"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error\tundefined-step\tfeatures/mixed.feature:9\t" +
        'No step definition matches "this line matches no step"; run `nuka scaffold --feature features/mixed.feature` to add one\n' +
        "nuka run did not start: nuka check reports 1 error for these scenarios. " +
        "Fix them, or pass --no-check to run anyway.\n",
    );
    expect(existsSync(path.join(rootDir, ".nukadoko", "records"))).toBe(false);
  });

  it("reaches the runtime failure under --no-check", async () => {
    const result = await run(rootDir, ["run", "--no-check", "features/mixed.feature"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("nuka run did not start");
    expect(scenarioOutcomes(result.stdout)).toEqual([
      ["features/mixed.feature", "clean", "passed"],
      ["features/mixed.feature", "undefined", "failed"],
    ]);
  });

  it("checks only the scenario a :line target selects", async () => {
    const result = await run(rootDir, ["run", "features/mixed.feature:3"]);

    expect(result.exitCode).toBe(0);
    expect(scenarioOutcomes(result.stdout)).toEqual([["features/mixed.feature", "clean", "passed"]]);
  });

  it("runs featuresDir when no target is given, the same scenarios `nuka run features` runs", async () => {
    await writeFile(
      path.join(rootDir, "features", "mixed.feature"),
      'Feature: Clean\n\n  Scenario: clean\n    Given a thing "widget" exists\n    Then the thing "widget" is there\n',
    );
    await mkdir(path.join(rootDir, "features", "nested"));
    await writeFile(
      path.join(rootDir, "features", "nested", "more.feature"),
      'Feature: More\n\n  Scenario: another\n    Given a thing "gadget" exists\n',
    );

    const bare = await run(rootDir, ["run"]);
    const named = await run(rootDir, ["run", "features"]);

    expect(bare.exitCode).toBe(0);
    expect(named.exitCode).toBe(0);
    expect(scenarioOutcomes(bare.stdout)).toEqual([
      ["features/mixed.feature", "clean", "passed"],
      ["features/nested/more.feature", "another", "passed"],
    ]);
    expect(scenarioOutcomes(named.stdout)).toEqual(scenarioOutcomes(bare.stdout));
  });
});

// A generated scenario line is one of: a clean Given, a clean Then, a
// mutating step in Then position (`then-mutates`), or a line no step
// matches (`undefined-step`).
const stepLine = gs.sampledFrom([
  'Given a thing "a" exists',
  'Then the thing "a" is there',
  'Then a thing "a" exists',
  "Then nothing matches this line",
]);
const scenario = gs.arrays(stepLine, { minSize: 1, maxSize: 3 });
const featureFile = gs.arrays(scenario, { minSize: 1, maxSize: 2 });
const featureSet = gs.arrays(featureFile, { minSize: 1, maxSize: 3 });

function featureSource(index: number, scenarios: readonly (readonly string[])[]): string {
  const body = scenarios
    .map((steps, scenarioIndex) => `  Scenario: s${scenarioIndex}\n${steps.map((line) => `    ${line}\n`).join("")}`)
    .join("\n");
  return `Feature: f${index}\n\n${body}`;
}

describe("the findings nuka run reports before executing", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-check-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it(
    "equal nuka check's errors for the same target, and the run executes exactly when there are none",
    () =>
      hegel.testAsync(
        async (tc) => {
          const files = tc.draw(featureSet);
          const featuresRoot = path.join(rootDir, "features");
          for (const name of ["mixed.feature", "generated"]) {
            await rm(path.join(featuresRoot, name), { recursive: true, force: true });
          }
          await rm(path.join(rootDir, ".nukadoko"), { recursive: true, force: true });
          await mkdir(path.join(featuresRoot, "generated"));
          const paths = files.map((_, index) => `features/generated/f${index}.feature`);
          for (const [index, scenarios] of files.entries()) {
            await writeFile(path.join(rootDir, paths[index]!), featureSource(index, scenarios));
          }
          const targetIndex = tc.draw(gs.integers({ minValue: -1, maxValue: paths.length - 1 }));
          const target = targetIndex === -1 ? [] : [paths[targetIndex]!];

          const checked = await run(rootDir, ["check", ...target]);
          const ran = await run(rootDir, ["run", ...target]);

          const expected = errorLines(checked.stdout);
          expect(errorLines(ran.stderr)).toEqual(expected);
          if (expected.length > 0) {
            expect(ran.exitCode).toBe(1);
            expect(ran.stdout).toBe("");
          } else {
            expect(ran.exitCode).toBe(0);
            expect(nonEmptyLines(ran.stdout).length).toBeGreaterThan(0);
          }
        },
        // Each case runs two commands that each import every step file, so a
        // case takes seconds, not microseconds, and a loaded machine trips
        // the generation-speed health check without anything being wrong.
        { testCases: 10, suppressHealthCheck: [hegel.HealthCheck.TooSlow] },
      ),
    180_000,
  );

  // A target here is one generated file or the directory that holds them
  // all, so a set of targets can name a file twice: once on its own and
  // once through the directory.
  async function writeGeneratedTargets(files: readonly (readonly (readonly string[])[])[]): Promise<string[]> {
    const featuresRoot = path.join(rootDir, "features");
    for (const name of ["mixed.feature", "generated"]) {
      await rm(path.join(featuresRoot, name), { recursive: true, force: true });
    }
    await rm(path.join(rootDir, ".nukadoko"), { recursive: true, force: true });
    await mkdir(path.join(featuresRoot, "generated"));
    const paths = files.map((_, index) => `features/generated/f${index}.feature`);
    for (const [index, scenarios] of files.entries()) {
      await writeFile(path.join(rootDir, paths[index]!), featureSource(index, scenarios));
    }
    return [...paths, "features/generated"];
  }

  it(
    "equal nuka check's errors for the same several targets, files and a directory mixed",
    () =>
      hegel.testAsync(
        async (tc) => {
          const candidates = await writeGeneratedTargets(tc.draw(featureSet));
          const targets = tc.draw(gs.arrays(gs.sampledFrom(candidates), { minSize: 1, maxSize: 4 }));

          const checked = await run(rootDir, ["check", ...targets]);
          const ran = await run(rootDir, ["run", ...targets]);

          expect(errorLines(ran.stderr)).toEqual(errorLines(checked.stdout));
        },
        { testCases: 10, suppressHealthCheck: [hegel.HealthCheck.TooSlow] },
      ),
    180_000,
  );
});

describe("nuka check with several targets", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-check-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it(
    "reports the union of each target's own report, each finding once",
    () =>
      hegel.testAsync(
        async (tc) => {
          const files = tc.draw(featureSet);
          const featuresRoot = path.join(rootDir, "features");
          await rm(path.join(featuresRoot, "generated"), { recursive: true, force: true });
          await mkdir(path.join(featuresRoot, "generated"));
          const paths = files.map((_, index) => `features/generated/f${index}.feature`);
          for (const [index, scenarios] of files.entries()) {
            await writeFile(path.join(rootDir, paths[index]!), featureSource(index, scenarios));
          }
          const candidates = [...paths, "features/generated", "features/mixed.feature"];
          const a = tc.draw(gs.sampledFrom(candidates));
          const b = tc.draw(gs.sampledFrom(candidates));

          // "ok: no issues found" stands for an empty report, not a finding.
          const findings = async (targets: string[]) =>
            nonEmptyLines((await run(rootDir, ["check", ...targets])).stdout).filter((line) => !line.startsWith("ok: "));
          const both = await findings([a, b]);
          const onlyA = await findings([a]);
          const onlyB = await findings([b]);

          expect(new Set(both).size).toBe(both.length);
          expect([...both].sort()).toEqual([...new Set([...onlyA, ...onlyB])].sort());
        },
        // Three checks per case, each importing every step file.
        { testCases: 10, suppressHealthCheck: [hegel.HealthCheck.TooSlow] },
      ),
    180_000,
  );
});
