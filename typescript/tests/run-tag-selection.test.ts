import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { feature, makeBaseProject, scenario } from "./helpers/base-project.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run --tag`, over tests/fixtures/run-directory-project
// with two feature files written under features/tagged/. A scenario runs only when its tags,
// those of its Feature: line and its Examples: block included, meet every
// `--tag` expression; run.json's `selection` and `tag_selection` and the
// summary say how many scenarios the tags left out; a run whose tags leave
// out every scenario, an expression nuka run does not read, and `--tag`
// beside a `:line` target are refused before anything runs.

const PROJECTS = [
  "@projects",
  "Feature: Projects",
  "",
  "  @web",
  "  Scenario: a project is created on the web",
  '    Given a thing "alpha" exists',
  "",
  "  @ios",
  "  Scenario: a project is created on the iPad",
  '    Given a thing "beta" exists',
  "",
  "  Scenario Outline: a project <name> is created",
  '    Given a thing "<name>" exists',
  "",
  "    @ios",
  "    Examples:",
  "      | name  |",
  "      | gamma |",
  "",
  "    Examples:",
  "      | name  |",
  "      | delta |",
  "",
].join("\n");

// Two files keep a scenario under `not @ios`, so --concurrency 2 hands
// each worker a file whose kept lines are not all of its scenarios.
const DEVICES = [
  "Feature: Devices",
  "",
  "  @ios",
  "  Scenario: a device is paired",
  '    Given a thing "epsilon" exists',
  "",
  "  Scenario: a device is listed",
  '    Given a thing "zeta" exists',
  "",
].join("\n");

interface Ran {
  readonly exitCode: number;
  readonly stderr: string;
}

async function inProject<T>(body: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await copyFixtureToTempDir("run-directory-project");
  try {
    mkdirSync(path.join(rootDir, "features", "tagged"));
    writeFileSync(path.join(rootDir, "features", "tagged", "projects.feature"), PROJECTS);
    writeFileSync(path.join(rootDir, "features", "tagged", "devices.feature"), DEVICES);
    return await body(rootDir);
  } finally {
    await removeTempDir(rootDir);
  }
}

async function cli(rootDir: string, argv: readonly string[]): Promise<Ran> {
  const stderr = createCaptureSink();
  const exitCode = await runCli([...argv], { rootDir, stdout: createCaptureSink(), stderr });
  return { exitCode, stderr: stderr.text() };
}

/** Each scenario that ran, as `file:line`, in the order run.json lists them. */
const ranScenarios = (rootDir: string): string[] =>
  (latestRunJson(rootDir).scenarios as { feature: string; line: number }[]).map((scenario) => `${scenario.feature}:${scenario.line}`).sort();

const selectionLine = (rootDir: string): string | undefined =>
  readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8")
    .split("\n")
    .find((line) => line.startsWith("- selection: "));

describe("nuka run --tag", () => {
  for (const concurrency of ["1", "2"]) {
    it(`runs only the scenarios whose tags meet the expression, Examples tags included, at --concurrency ${concurrency}`, () =>
      inProject(async (rootDir) => {
        expect((await cli(rootDir, ["run", "features/tagged", "--tag", "not @ios", "--concurrency", concurrency])).exitCode).toBe(0);

        expect(ranScenarios(rootDir)).toEqual(["features/tagged/devices.feature:7", "features/tagged/projects.feature:22", "features/tagged/projects.feature:5"]);
        const document = latestRunJson(rootDir);
        expect(document.selection).toBe("partial");
        expect(document.tag_selection).toEqual({ expressions: ["not @ios"], left_out: 3 });
        expect(selectionLine(rootDir)).toBe('- selection: partial (`--tag "not @ios"` left out 3 scenarios of the targeted files)');
      }));
  }

  it("reads a Feature: line's tag on each scenario under it, and a scenario has to meet every --tag", () =>
    inProject(async (rootDir) => {
      expect((await cli(rootDir, ["run", "features/tagged", "--tag", "@projects", "--tag", "not @web"])).exitCode).toBe(0);

      expect(ranScenarios(rootDir)).toEqual(["features/tagged/projects.feature:18", "features/tagged/projects.feature:22", "features/tagged/projects.feature:9"]);
      expect(latestRunJson(rootDir).tag_selection).toEqual({ expressions: ["@projects", "not @web"], left_out: 3 });
      expect(selectionLine(rootDir)).toBe('- selection: partial (`--tag "@projects" --tag "not @web"` left out 3 scenarios of the targeted files)');
    }));

  it("is a full run when every scenario of the targeted files meets the tags, and the summary says it was tag-selected", () =>
    inProject(async (rootDir) => {
      expect((await cli(rootDir, ["run", "features/tagged/projects.feature", "--tag", "@projects"])).exitCode).toBe(0);

      const document = latestRunJson(rootDir);
      expect(document.selection).toBe("full");
      expect(document.tag_selection).toEqual({ expressions: ["@projects"], left_out: 0 });
      expect(selectionLine(rootDir)).toBe('- selection: full (every scenario of the targeted files meets `--tag "@projects"`)');
    }));

  it("leaves tag_selection out of a run without --tag", () =>
    inProject(async (rootDir) => {
      expect((await cli(rootDir, ["run", "features/tagged/devices.feature"])).exitCode).toBe(0);

      expect(latestRunJson(rootDir)).not.toHaveProperty("tag_selection");
      expect(selectionLine(rootDir)).toBe("- selection: full");
    }));

  it("fails a run whose tags leave out every scenario, and writes no run", () =>
    inProject(async (rootDir) => {
      expect(await cli(rootDir, ["run", "features/tagged", "--tag", "@android"])).toEqual({
        exitCode: 1,
        stderr:
          "failed\tnothing-selected\t-\tno scenario to run: --tag @android left out all 6 scenarios of features/tagged, so nothing was checked\n" +
          "  fix: Name a tag a scenario of the targets carries, or run without --tag.\n",
      });
      expect(existsSync(path.join(rootDir, ".nukadoko", "runs"))).toBe(false);
    }));

  it("refuses an expression it does not read", () =>
    inProject(async (rootDir) => {
      expect(await cli(rootDir, ["run", "features/tagged", "--tag", "@web and @ios"])).toEqual({
        exitCode: 2,
        stderr:
          'refused\tinvalid-value\t-\t--tag "@web and @ios" is not an expression nuka run reads: give "@name" or "not @name", and repeat --tag for a scenario that has to meet more than one\n' +
          "  fix: Correct the flag's value as the message says.\n" +
          "  do: nuka run --help\n",
      });
    }));

  it("refuses --tag beside a :line target", () =>
    inProject(async (rootDir) => {
      expect(await cli(rootDir, ["run", "features/tagged/projects.feature:5", "--tag", "@web"])).toEqual({
        exitCode: 2,
        stderr:
          'refused\tinvalid-value\t-\t--tag selects among whole files, and "features/tagged/projects.feature:5" already names one scenario\n' +
          "  fix: Drop --tag to run that scenario, or drop the :line to select by tag in its file.\n",
      });
    }));
});

describe("nuka run --tag --base", () => {
  it("compares only the scenarios the tags kept, and keeps a targeted file the tags left out whole from reading as removed", async () => {
    const project = await makeBaseProject();
    try {
      project.write({
        "specs/cart.feature": feature(scenario("two items", 2, 4), scenario("three items on the iPad", 3, 6, "@ios")),
        "specs/ipad.feature": feature(scenario("one item on the iPad", 1, 2, "@ios")),
      });
      const base = project.commit("base");
      project.write({
        "specs/cart.feature": feature(scenario("two items", 2, 4), scenario("three items on the iPad", 3, 6, "@ios"), scenario("four items", 4, 8)),
      });
      project.commit("head");

      // specs/ lies outside featuresDir, so the comparison reads only the
      // targeted files: a file the tags left out whole has to stay among
      // them. --base runs no tree for a file there (each such cell says
      // so), which is why the verdicts are not asserted here.
      const ran = await project.cli(["run", "specs", "--base", base, "--tag", "not @ios"]);
      expect(ran.exitCode, ran.stderr).toBe(1);
      const document = latestRunJson(project.root);
      expect((document.table.rows as { name: string; change: string }[]).map((row) => [row.name, row.change])).toEqual([
        ["two items", "unchanged"],
        ["four items", "new"],
      ]);
      expect(document.tag_selection).toEqual({ expressions: ["not @ios"], left_out: 2 });
    } finally {
      await removeTempDir(project.top);
    }
  });
});
