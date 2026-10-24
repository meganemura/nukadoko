import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

describe("an unknown --env names every environment --env accepts, default included", () => {
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
        'refused\tunknown-environment\t-\tUnknown environment "stagign": not defined in nukadoko.program.ts\'s "environments"\n' +
        "  fix: Pass --env with a name it accepts (default, no-overrides, probe-ok, probe-throws, readonly, staging), or add environments.stagign to nukadoko.program.ts.\n",
    });
  });

  it("offers --env default when the program file defines no environment", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--env", "staging"], { rootDir: fixture("pure-step-project"), stdout: createCaptureSink(), stderr });
    expect({ exitCode, stderr: stderr.text() }).toEqual({
      exitCode: 2,
      stderr:
        'refused\tunknown-environment\t-\tUnknown environment "staging": not defined in nukadoko.program.ts\'s "environments"\n' +
        "  fix: Leave out --env or pass --env default (nukadoko.program.ts defines no other environment), or add environments.staging to nukadoko.program.ts.\n",
    });
  });
});
