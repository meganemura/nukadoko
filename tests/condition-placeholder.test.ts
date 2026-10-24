import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `{condition.<name>}`, the placeholder that derives a
// program's switch from the environment's own condition, against
// tests/fixtures/condition-placeholder-project, where BANNER is
// "{condition.banner}". A condition is the environment's word, and this is
// how the program and that word cannot disagree: editing the word edits
// the program. Each cell of the table names the conditions its role came
// from, and the summary's column headings show them. A world whose
// environment does not declare the condition has no value for it, and is
// refused by name before anything runs.

async function withProject<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await copyFixtureToTempDir("condition-placeholder-project");
  try {
    return await fn(rootDir);
  } finally {
    await removeTempDir(rootDir);
  }
}

async function cli(rootDir: string, argv: readonly string[]) {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(argv, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

describe("{condition.<name>}", () => {
  it("fills each environment's own value, so the control runs the program with the switch off, and each cell names its conditions", () =>
    withProject(async (rootDir) => {
      expect((await cli(rootDir, ["check"])).exitCode).toBe(0);
      const { exitCode } = await cli(rootDir, ["run"]);
      expect(exitCode).toBe(0);
      const document = latestRunJson(rootDir);
      const row = document.table.rows[0];
      expect(row.verdict).toBe("proven");
      expect(row.cells.map((cell: Record<string, unknown>) => [cell.environment, cell.role, cell.conditions, cell.outcome])).toEqual([
        ["flag-off", "control", { banner: false }, "fail"],
        ["flag-on", "required", { banner: true }, "pass"],
      ]);
      const claims = (document.scenarios as { environment: string; steps: { claims?: { actual: unknown }[] }[] }[]).map((scenario) => [
        scenario.environment,
        scenario.steps[0]!.claims?.[0]?.actual,
      ]);
      expect(claims).toContainEqual(["flag-off", "false"]);
      expect(claims).toContainEqual(["flag-on", "true"]);
      const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
      expect(summary).toContain("| verdict | criterion | head flag-off (banner: false) | head flag-on (banner: true) |\n");
    }));

  it("moves the program with the word: declaring flag-off's banner on makes both cells required, and both pass", () =>
    withProject(async (rootDir) => {
      const programPath = path.join(rootDir, "nukadoko.program.ts");
      await writeFile(programPath, readFileSync(programPath, "utf8").replace('"flag-off": { conditions: { banner: false } }', '"flag-off": { conditions: { banner: true } }'));
      expect((await cli(rootDir, ["run"])).exitCode).toBe(0);
      const row = latestRunJson(rootDir).table.rows[0];
      expect(row.cells.map((cell: Record<string, unknown>) => [cell.environment, cell.role, cell.outcome])).toEqual([
        ["flag-off", "required", "pass"],
        ["flag-on", "required", "pass"],
      ]);
      expect(row.verdict).toBe("held");
    }));

  it("is refused by name in a world whose environment does not declare the condition", () =>
    withProject(async (rootDir) => {
      const check = await cli(rootDir, ["check", "--env", "staging"]);
      expect(check.exitCode).toBe(1);
      expect(check.stdout).toContain(
        'error\tprogram-placeholder-unfilled\tnukadoko.program.ts\tworld staging: env.BANNER names {condition.banner}, which has no value here: its environment declares no condition "banner" under conditions\n' +
          "  fix: Declare banner under conditions of world staging in nukadoko.program.ts, or remove {condition.banner} from env.BANNER.\n",
      );
      const run = await cli(rootDir, ["run", "--no-check", "--env", "staging"]);
      expect(run.exitCode).toBe(2);
      expect(run.stderr).toContain(
        'refused\tprogram-placeholder-unfilled\t-\tworld staging: env.BANNER names {condition.banner}, which has no value here: its environment declares no condition "banner" under conditions; nothing ran\n',
      );
    }));

  it("is checked for the worlds a run with the same --env flags would start, and no other", () =>
    withProject(async (rootDir) => {
      // Without --env a run starts flag-off and flag-on, the environments
      // that declare conditions, so neither staging nor the implicit
      // default world, which declare no banner, is checked.
      const plain = await cli(rootDir, ["check"]);
      expect(plain.exitCode).toBe(0);
      expect(plain.stdout).not.toContain("program-placeholder-unfilled");
      const named = await cli(rootDir, ["check", "--env", "flag-on"]);
      expect(named.exitCode).toBe(0);
      expect(named.stdout).not.toContain("program-placeholder-unfilled");
      const both = await cli(rootDir, ["check", "--env", "flag-on", "--env", "default"]);
      expect(both.exitCode).toBe(1);
      expect(both.stdout).toContain("program-placeholder-unfilled\tnukadoko.program.ts\tworld default: env.BANNER names {condition.banner}");
      expect(both.stdout).not.toContain("world flag-on:");
      expect(both.stdout).not.toContain("world staging:");
    }));
});
