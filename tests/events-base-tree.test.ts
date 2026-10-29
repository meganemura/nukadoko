import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { rowSummary, type TableRow } from "./helpers/base-project.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: that `nuka run --base` runs the base world when head's
// steps count execution events and the ref's program file names no
// `{events}`, the shape of the change that adds them. The base tree's
// check does not stop the tree on `events-inlet-missing`: the claim on a
// count is unjudged there with the gap word, and the row's other cells
// run as before.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
}

async function cli(rootDir: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(args, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

const program = (env: string): string =>
  `import { defineProgram } from "./nukadoko-shim.js";\n\nexport default defineProgram({\n  serve: { command: "node app/server.mjs", ready: "/up" },\n  env: { ${env} },\n});\n`;

const feature = (...scenarios: string[]): string => `Feature: Counts of what the program did\n\n${scenarios.join("\n")}`;

const READ = `  Scenario: a read\n    When the client gets "/rooms/7"\n`;
const WRITE = `  Scenario: a write\n    When the client posts to "/scores"\n    Then "scores" was written 1 time\n`;

describe("--base with a ref whose program file names no {events}", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
    // A tree is checked out under the run directory, so the shim's relative
    // path would not reach the source from there.
    writeFileSync(path.join(rootDir, "nukadoko-shim.ts"), `export * from ${JSON.stringify(path.resolve("src/index.js"))};\n`);
    writeFileSync(path.join(rootDir, ".gitignore"), ".nukadoko/\n");
    git(rootDir, "init", "-q", "-b", "main");
    writeFileSync(path.join(rootDir, "nukadoko.program.ts"), program(`PORT: "{port}", JOBS_DIR: "{dir}/jobs"`));
    writeFileSync(path.join(rootDir, "features", "events.feature"), feature(READ));
    git(rootDir, "add", "-A");
    git(rootDir, "commit", "-q", "-m", "base");
    git(rootDir, "branch", "base-branch");
    writeFileSync(path.join(rootDir, "nukadoko.program.ts"), program(`PORT: "{port}", EXECUTION_EVENTS: "{events}", JOBS_DIR: "{dir}/jobs"`));
    writeFileSync(path.join(rootDir, "features", "events.feature"), feature(READ, WRITE));
    git(rootDir, "add", "-A");
    git(rootDir, "commit", "-q", "-m", "head");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("runs the new row at the base, where the claim on a count is unjudged for want of an inlet", async () => {
    const { stdout } = await cli(rootDir, ["run", "--base", "base-branch"]);
    const run = latestRunJson(rootDir) as {
      table: { rows: TableRow[] };
      scenarios: { scenario: string; world?: string; steps: { claims?: { outcome: string; reason?: string }[] }[] }[];
    };
    const write = run.table.rows.find((row) => row.name === "a write")!;
    expect(rowSummary([write]), stdout).toEqual([["a write", "new", "unproven", ["head:default:pass", "base:default:broke"]]]);
    expect(write.reason).toBe("passes in default, and nothing shows a Then failing where its behaviour is absent (base default: broke@8)");
    const atBase = run.scenarios.find((scenario) => scenario.scenario === "a write" && scenario.world === "base")!;
    const [claim] = atBase.steps[1]!.claims!;
    expect(claim!.outcome).toBe("unjudged");
    expect(claim!.reason).toContain("(inlet-unnamed): the program file names no {events}");
  }, 120_000);
});
