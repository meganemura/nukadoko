import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

describe("an unknown --env names the environments the config defines", () => {
  it.each([
    [["do", "get-context", "--args", "{}", "--env", "stagign"]],
    [["run", "--env", "stagign"]],
  ])("nuka %j", async (argv) => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(argv, { rootDir: fixture("environments-project"), stdout, stderr });
    expect({ exitCode, stderr: stderr.text() }).toEqual({
      exitCode: 2,
      stderr:
        'refused\tunknown-environment\t-\tUnknown environment "stagign": not defined in nukadoko.config.ts\'s "environments"\n' +
        "  fix: Pass --env with a name the config defines (no-overrides, probe-ok, probe-throws, readonly, staging), or add environments.stagign to the config file.\n",
    });
  });
});
