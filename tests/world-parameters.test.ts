import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the compat World a migrated suite runs against receives
// `nukadoko.config.ts`'s `worldParameters` as `this.parameters`. The
// constructor used to be handed `{}` with no config key to replace it, so
// a read of `this.parameters.baseUrl` was `undefined` and nothing failed
// until the value was used.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

describe("nuka run: worldParameters", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("world-parameters-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("passes the config object to the World as this.parameters", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "features/parameters.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).not.toContain("Invalid config");
    expect(stderr.text()).not.toContain("world parameters were");
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps[0].status).toBe("passed");
  });
});
