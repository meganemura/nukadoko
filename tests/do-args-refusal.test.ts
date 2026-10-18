import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { describeArgsCommand } from "../src/cli/option-defaults.js";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture, withoutNoConfigLine } from "./helpers/fixtures.js";

async function doRefusal(argv: string[]): Promise<{ exitCode: number; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(argv, { rootDir: fixture("basic-project"), stdout, stderr });
  return { exitCode, stderr: withoutNoConfigLine(stderr.text()) };
}

describe("nuka do without usable --args names the command that prints the args schema", () => {
  it("--args left out", async () => {
    expect(await doRefusal(["do", "create-project"])).toEqual({
      exitCode: 2,
      stderr: "refused\tstep-args-invalid\t-\t--args is required unless --use supplies this step's arguments\n  do: nuka describe create-project\n",
    });
  });

  it("--args that is not JSON", async () => {
    expect(await doRefusal(["do", "create-project", "--args", "name=x"])).toEqual({
      exitCode: 2,
      stderr:
        "refused\tstep-args-invalid\t-\tInvalid JSON for --args: Unexpected token 'a', \"name=x\" is not valid JSON\n  do: nuka describe create-project\n",
    });
  });

  it("an unknown flag keeps the command's help", async () => {
    expect(await doRefusal(["do", "create-project", "--bogus"])).toEqual({
      exitCode: 2,
      stderr: "refused\tinvalid-arguments\t-\tUnknown argument: bogus\n  fix: Correct the command line; the command's --help lists its flags.\n  do: nuka do --help\n",
    });
  });

  it("--args left out for a name no step has is refused as an unknown step", async () => {
    expect(await doRefusal(["do", "no-such-step"])).toEqual({
      exitCode: 2,
      stderr: "refused\tunknown-step\t-\tUnknown step: no-such-step\n  do: nuka steps\n",
    });
  });

  it("--args that is not JSON for a name no step has is refused as an unknown step", async () => {
    expect(await doRefusal(["do", "no-such-step", "--args", "name=x"])).toEqual({
      exitCode: 2,
      stderr: "refused\tunknown-step\t-\tUnknown step: no-such-step\n  do: nuka steps\n",
    });
  });

  it("names describe only for a name that needs no shell quoting", () =>
    hegel.test((tc) => {
      const name = tc.draw(gs.text({ maxSize: 12 }));
      expect(describeArgsCommand(name, "nuka do --help")).toBe(
        /^[a-z0-9-]+$/.test(name) ? `nuka describe ${name}` : "nuka do --help",
      );
    }));
});
