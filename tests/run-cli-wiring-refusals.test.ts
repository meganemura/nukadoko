import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: the removed commands, each refused by name with what
// replaces it, and `nuka describe`'s own ConfigError propagation, which
// `nuka steps`' sibling test (cli.test.ts) already proves for `steps`.

describe("nuka harvest, removed", () => {
  it("exits 2 and names what replaced it, with or without arguments", async () => {
    for (const argv of [["harvest"], ["harvest", "step-20260817-a1b2", "--unknown-flag"]]) {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(argv, { rootDir: fixture("basic-project"), stdout, stderr });

      expect(exitCode).toBe(2);
      expect(stderr.text()).toBe(
        "refused\tremoved-command\t-\t`nuka harvest` was removed (see docs/upgrading.md in the nukadoko package)\n" +
          "  fix: Write the scenario from the steps you ran in a feature file.\n" +
          "  do: nuka check\n",
      );
      expect(stdout.text()).toBe("");
    }
  });
});

describe("nuka session, nuka experimental explore and nuka explore, removed", () => {
  const REMOVED = [
    {
      argv: ["session", "list"],
      stderr:
        "refused\tremoved-command\t-\t`nuka session` was removed with sessions: each nuka do call starts clean, and a step that needs " +
        "login state gets it from a fixture (see docs/upgrading.md in the nukadoko package)\n" +
        "  fix: Give the step a fixture that logs in, and delete .nukadoko/cache/.\n" +
        "  do: nuka do --help\n",
    },
    {
      argv: ["experimental", "explore", "features/model.ts"],
      stderr:
        "refused\tremoved-command\t-\t`nuka experimental explore` was removed with models and relations " +
        "(see docs/upgrading.md in the nukadoko package)\n" +
        "  fix: Write each sequence the model found as a scenario in a feature file.\n" +
        "  do: nuka check\n",
    },
    {
      argv: ["explore", "features/model.ts"],
      stderr:
        "refused\tremoved-command\t-\t`nuka explore` was removed with models and relations " +
        "(see docs/upgrading.md in the nukadoko package)\n" +
        "  fix: Write each sequence the model found as a scenario in a feature file.\n" +
        "  do: nuka check\n",
    },
  ];

  it.each(REMOVED)("exits 2 and names what replaced it ($argv)", async ({ argv, stderr: expected }) => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(argv, { rootDir: fixture("basic-project"), stdout, stderr });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toBe(expected);
    expect(stdout.text()).toBe("");
  });
});

describe("nuka describe: config load failure", () => {
  it("refuses a ConfigError as JSON on stdout, exit 2", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["describe", "some-step"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toBe("");
    const refusal = (JSON.parse(stdout.text()) as { findings: { code: string; message: string; fix: string }[] }).findings.at(-1)!;
    expect(refusal.code).toBe("config-invalid");
    expect(refusal.message).toContain("typo");
    expect(refusal.fix).toBe("Correct the fields the message names in nukadoko.config.ts.");
  });
});
