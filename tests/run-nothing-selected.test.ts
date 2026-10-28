import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a `nuka run` whose selection holds no scenario checked
// nothing, so it is no pass. It exits 1 with one `nothing-selected` finding,
// writes no run directory, and its `do:` line, when it has one, runs as
// printed. Against tests/fixtures/run-verdict-hooks-project, whose
// features/banner.feature:4 needs the `banner` condition that only the
// `flag-on` environment meets.

interface Ran {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(rootDir: string, argv: readonly string[]): Promise<Ran> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli([...argv], { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

async function inProject<T>(body: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await copyFixtureToTempDir("run-verdict-hooks-project");
  try {
    writeFileSync(path.join(rootDir, "features", "empty.feature"), "Feature: Nothing yet\n");
    return await body(rootDir);
  } finally {
    await removeTempDir(rootDir);
  }
}

const doLineOf = (stderr: string): string | undefined => stderr.split("\n").find((line) => line.startsWith("  do: "))?.slice("  do: ".length);

describe("nuka run: a selection with no scenario is no pass", () => {
  for (const concurrency of ["1", "2"]) {
    it(`fails a target that holds no scenario and writes no run, at --concurrency ${concurrency}`, () =>
      inProject(async (rootDir) => {
        expect(await cli(rootDir, ["run", "features/empty.feature", "--concurrency", concurrency])).toEqual({
          exitCode: 1,
          stdout: "",
          stderr:
            "failed\tnothing-selected\t-\tno scenario to run in features/empty.feature, so nothing was checked\n" +
            "  fix: Add a scenario to the feature files the targets name, or name a target that holds one.\n",
        });
        expect(existsSync(path.join(rootDir, ".nukadoko", "runs"))).toBe(false);
      }));

    it(`fails an --env that leaves out every selected scenario, and its do: line runs them, at --concurrency ${concurrency}`, () =>
      inProject(async (rootDir) => {
        const ran = await cli(rootDir, ["run", "features/banner.feature:4", "--env", "flag-off", "--concurrency", concurrency]);
        expect(ran).toEqual({
          exitCode: 1,
          stdout: "",
          stderr:
            "failed\tnothing-selected\t-\tno scenario to run: the conditions of the 1 selected scenario hold in no environment --env names (flag-off), so nothing was checked\n" +
            "  fix: Run without --env, which selects the environments that declare conditions, or name an environment that meets the scenario's tags.\n" +
            "  do: nuka run features/banner.feature:4\n",
        });
        expect(existsSync(path.join(rootDir, ".nukadoko", "runs"))).toBe(false);

        const rerun = await cli(rootDir, doLineOf(ran.stderr)!.split(" ").slice(1));
        expect(rerun.exitCode).toBe(0);
        expect(rerun.stderr).toContain("1 scenario: 1 passed, 0 failed");
      }));
  }

  it("prints the finding in the --json envelope, with verdict failed", () =>
    inProject(async (rootDir) => {
      const ran = await cli(rootDir, ["run", "features/empty.feature", "--json"]);
      expect(ran.exitCode).toBe(1);
      expect(ran.stderr).toBe("");
      const document = JSON.parse(ran.stdout) as { verdict: string; findings: { severity: string; code: string }[] };
      expect(document.verdict).toBe("failed");
      expect(document.findings.map((finding) => `${finding.severity} ${finding.code}`)).toEqual(["failed nothing-selected"]);
    }));
});
