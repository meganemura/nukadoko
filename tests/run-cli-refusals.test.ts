import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka run`'s own setup-phase refusals (src/cli/run.ts)
// that run.test.ts and its siblings never reach. Every one of these returns
// before `selectPickles` is ever called, so the feature argument itself is
// never read; none of them needs a project whose feature file actually
// parses.

describe("nuka run: setup-phase refusals reachable before any pickle is selected", () => {
  it("rejects an unknown --env name", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/whatever.feature", "--env", "no-such-env"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("no-such-env");
  });

  it("refuses --session by name and says where login state comes from instead", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["run", "--no-check", "features/whatever.feature", "--session", "alice"],
      { rootDir: fixture("basic-project"), stdout, stderr },
    );

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe(
      "refused\tremoved-flag\t-\tnuka run --session is removed: a scenario that needs login state gets it from a fixture or a Given step " +
        "its feature names.\n" +
        "  fix: Use what the message names in its place.\n",
    );
  });

  it("propagates a step discovery failure (a broken glue file) as exit 2 with a stderr message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--no-check", "features/whatever.feature"], {
      rootDir: fixture("discover-import-failure-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("require is not defined");
  });
});
