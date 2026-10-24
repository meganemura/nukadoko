import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: which criteria a run selects, against
// tests/fixtures/run-verdict-hooks-project (run-verdict-project's two
// features and three environments, with run hooks hooks.json can fail).
// Under `--env`, a criterion no named environment meets is left out of
// the run and counted, and `nuka check --env` does not report it; the
// program file's `defaultEnvironments` names what a run without `--env`
// starts; a red row with no required cell, which only `--no-check` lets
// run, has a finding whose `do:` line runs; and each `do:` line a hook
// failure prints runs as printed.

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
    return await body(rootDir);
  } finally {
    await removeTempDir(rootDir);
  }
}

function writeProgram(rootDir: string, environments: string, top = ""): void {
  writeFileSync(
    path.join(rootDir, "nukadoko.program.ts"),
    ['import { defineProgram } from "./nukadoko-shim.js";', "export default defineProgram({", top, `  environments: { ${environments} },`, "});", ""].join("\n"),
  );
}

const STAGING = 'staging: { envFiles: [".env.flag-on"] }';
const FLAG_OFF = '"flag-off": { envFiles: [".env.flag-off"], conditions: { banner: false } }';
const FLAG_ON = '"flag-on": { envFiles: [".env.flag-on"], conditions: { banner: true } }';

/** The `do:` command of each finding with `code` on stderr, as an argv. */
function doLines(stderr: string, code: string): string[][] {
  const lines = stderr.split("\n");
  const commands: string[][] = [];
  lines.forEach((line, index) => {
    if (!line.startsWith(`failed\t${code}\t`)) return;
    const next = lines.slice(index + 1).find((entry) => entry.startsWith("  do: "));
    if (next !== undefined) commands.push(next.slice("  do: ".length).split(" "));
  });
  return commands;
}

type Row = { feature: string; line: number; verdict: string };
const rowsOf = (rootDir: string): string[] => (latestRunJson(rootDir).table.rows as Row[]).map((row) => `${row.feature}:${row.line} ${row.verdict}`);

describe("nuka run: which criteria a run selects", () => {
  for (const concurrency of ["1", "2"]) {
    it(`leaves out, under --env, a criterion no named environment meets, and counts it, at --concurrency ${concurrency}`, () =>
      inProject(async (rootDir) => {
        const check = await cli(rootDir, ["check", "--env", "flag-on"]);
        expect(check.stdout).not.toContain("condition-unmet");
        expect(check.exitCode).toBe(0);

        const { exitCode, stderr } = await cli(rootDir, ["run", "--env", "flag-on", "--concurrency", concurrency]);
        expect(exitCode).toBe(0);
        expect(rowsOf(rootDir)).toEqual(["features/banner.feature:4 held", "features/value.feature:3 held", "features/value.feature:7 held"]);
        const document = latestRunJson(rootDir);
        expect(document.table.left_out).toBe(1);
        expect((document.scenarios as { line: number }[]).map((scenario) => scenario.line).sort((a, b) => a - b)).toEqual([3, 4, 7]);
        expect(stderr).toContain("\n1 criterion not run: its conditions hold in no selected environment\n");
        const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
        expect(summary).toContain("| held | `features/value.feature:7` the banner has a value where it is on `@with:banner` `@held` | pass |\n\n1 criterion not run: its conditions hold in no selected environment\n");
      }));
  }

  it("runs nothing when --env leaves out every targeted criterion, and says why", () =>
    inProject(async (rootDir) => {
      const { exitCode, stderr } = await cli(rootDir, ["run", "--env", "flag-on", "features/banner.feature:8"]);
      expect(exitCode).toBe(0);
      expect(stderr).toContain("0 scenarios: 0 passed, 0 failed");
      expect(stderr).toContain("\n1 criterion not run: its conditions hold in no selected environment\n");
      expect(existsSync(path.join(rootDir, ".nukadoko", "runs"))).toBe(false);
    }));

  it("starts the environments defaultEnvironments names without --env, so a deployment target can declare its switches", () =>
    inProject(async (rootDir) => {
      writeProgram(rootDir, `staging: { envFiles: [".env.flag-on"], conditions: { banner: true } }, ${FLAG_OFF}, ${FLAG_ON}`, '  defaultEnvironments: ["flag-off", "flag-on"],');
      const { exitCode } = await cli(rootDir, ["run"]);
      expect(exitCode).toBe(0);
      expect(latestRunJson(rootDir).table.worlds).toEqual([
        { world: "head", environment: "flag-off" },
        { world: "head", environment: "flag-on" },
      ]);
      expect(latestRunJson(rootDir).table.left_out).toBe(0);
    }));

  it("keeps a red row with no required cell under the default selection, with a finding whose do: runs it where it is met", () =>
    inProject(async (rootDir) => {
      writeProgram(rootDir, `${STAGING}, ${FLAG_OFF}, ${FLAG_ON}`, '  defaultEnvironments: ["flag-off"],');
      // The default selection is the program file's, which is expected to
      // cover every condition a tag names.
      const check = await cli(rootDir, ["check", "features/banner.feature"]);
      expect(check.exitCode).toBe(1);
      expect(check.stdout).toMatch(/^error\tcondition-unmet\tfeatures\/banner\.feature:4\t/m);

      const ran = await cli(rootDir, ["run", "--no-check", "features/banner.feature"]);
      expect(ran.exitCode).toBe(1);
      expect(rowsOf(rootDir)).toEqual(["features/banner.feature:4 failed", "features/banner.feature:8 held"]);
      expect(ran.stderr).toContain(
        "failed\tcriterion-without-required-cell\tfeatures/banner.feature:4\tScenario \"the banner is on\" needs @with:banner, and no environment of this run meets it: flag-off (banner: false). Its cells are all controls, so nothing shows that it holds\n" +
          "  do: nuka run features/banner.feature:4 --env flag-on\n",
      );
      const finding = (latestRunJson(rootDir).findings as { code: string; do?: string }[]).find((entry) => entry.code === "criterion-without-required-cell");
      expect(finding?.do).toBe("nuka run features/banner.feature:4 --env flag-on");

      const [command] = doLines(ran.stderr, "criterion-without-required-cell");
      const rerun = await cli(rootDir, command!.slice(1));
      expect(rerun.exitCode).toBe(0);
      expect(rowsOf(rootDir)).toEqual(["features/banner.feature:4 held"]);
    }));

  it("gives a row no environment of the program file meets a do: line that checks its file", () =>
    inProject(async (rootDir) => {
      writeFileSync(path.join(rootDir, "features", "unmet.feature"), 'Feature: Unmet\n\n  @with:banner=yes\n  Scenario: the banner says yes\n    Then the banner reads "yes"\n');
      const ran = await cli(rootDir, ["run", "--no-check", "features/unmet.feature"]);
      expect(ran.exitCode).toBe(1);
      expect(rowsOf(rootDir)).toEqual(["features/unmet.feature:4 failed"]);
      expect(doLines(ran.stderr, "criterion-without-required-cell")).toEqual([["nuka", "check", "features/unmet.feature"]]);
      const check = await cli(rootDir, ["check", "features/unmet.feature"]);
      expect(check.exitCode).toBe(1);
      expect(check.stdout).toMatch(/^error\tcondition-unmet\tfeatures\/unmet\.feature:4\t/m);
    }));

  it("runs each do: line a hook failure prints, as printed", () =>
    inProject(async (rootDir) => {
      writeFileSync(path.join(rootDir, "hooks.json"), JSON.stringify({ afterAll: true }));
      const failed = await cli(rootDir, ["run"]);
      expect(failed.exitCode).toBe(1);
      const commands = doLines(failed.stderr, "hook-failed");
      expect(commands).toEqual([
        ["nuka", "run", "--env", "flag-off"],
        ["nuka", "run", "--env", "flag-on"],
      ]);
      // Each one still meets the failing hook, and runs to its end.
      for (const command of commands) {
        const again = await cli(rootDir, command.slice(1));
        expect(again.stderr, command.join(" ")).not.toMatch(/^refused\t/m);
        expect(again.exitCode, command.join(" ")).toBe(1);
        expect(again.stderr, command.join(" ")).toContain(`failed\thook-failed\t-\tAfterAll failed in environment "${command[3]}": AfterAll fails\n`);
      }
      // With the hook fixed, each one passes, and counts what it left out:
      // flag-off meets neither @with:banner scenario, and flag-on does not
      // meet the @without:banner one.
      writeFileSync(path.join(rootDir, "hooks.json"), "{}");
      for (const [command, leftOut] of [
        [commands[0]!, "2 criteria not run: their conditions hold"],
        [commands[1]!, "1 criterion not run: its conditions hold"],
      ] as const) {
        const fixed = await cli(rootDir, command.slice(1));
        expect(fixed.exitCode, command.join(" ")).toBe(0);
        expect(fixed.stderr, command.join(" ")).toContain(`\n${leftOut} in no selected environment\n`);
      }
    }));
});
