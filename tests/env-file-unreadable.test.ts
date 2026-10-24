import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir, withoutNoConfigLine } from "./helpers/fixtures.js";

// Responsibility: a configured env file that is on disk and cannot be read
// (here a directory at its path, which a root user cannot read either) is
// the `env-file-unreadable` refusal, exit 2, under every command that
// reads the env files, `nuka run --no-check` included: nothing has run
// yet, so it is a setup problem like an invalid config, not a failed run.

const REFUSAL =
  'refused\tenv-file-unreadable\t-\tenv file ".env.local" could not be read: EISDIR\n' +
  "  fix: Make the file readable, replace the directory with a file, or remove the path from envFiles.\n";

describe("an envFiles path that cannot be read", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
    const configPath = path.join(rootDir, "nukadoko.config.ts");
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace("defineConfig({})", 'defineConfig({ envFiles: [".env.local"] })'));
    mkdirSync(path.join(rootDir, ".env.local"));
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it.each([
    [["check"], "check"],
    [["run", "features/passing.feature"], "run"],
    [["run", "--no-check", "features/passing.feature"], "run"],
    [["do", "ambiguous-a", "--args", "{}"], "do"],
  ])("nuka %j refuses with env-file-unreadable", async (argv, command) => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(argv, { rootDir, stdout: createCaptureSink(), stderr });
    expect({ exitCode, stderr: withoutNoConfigLine(stderr.text()) }).toEqual({ exitCode: 2, stderr: `${REFUSAL}  do: nuka ${command} --help\n` });
  });
});
