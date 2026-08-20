import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run`'s own version-probe call (cli/run.ts's own
// probeVersion() call): both the success case (records target_version on
// the scenario record) and the failure case (warns on stderr, still runs
// the scenario). tests/environment.test.ts already proves both shapes for
// `nuka do`'s own separate probeVersion() call site; exercised here through
// `nuka run` instead, against a fixture dedicated to this one call site
// (tests/fixtures/environments-project has no .feature file of its own,
// since every test against it drives `nuka do`, which addresses a step by
// name).

describe("nuka run: an environment's own version probe", () => {
  it("records target_version on the scenario record when the probe succeeds", async () => {
    const rootDir = await copyFixtureToTempDir("run-version-probe-warning-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(
        ["run", "features/noop.feature", "--env", "probe-ok"],
        { rootDir, stdout, stderr },
      );

      expect(exitCode).toBe(0);
      expect(stderr.text()).not.toContain("Warning: version probe");
      const record = JSON.parse(stdout.text().split("\n").filter((line) => line.length > 0)[0]!);
      expect(record.status).toBe("passed");
      expect(record.target_version).toBe("9.9.9");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("warns on stderr naming the environment and reason, but still runs the scenario, when the probe throws", async () => {
    const rootDir = await copyFixtureToTempDir("run-version-probe-warning-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(
        ["run", "features/noop.feature", "--env", "probe-throws"],
        { rootDir, stdout, stderr },
      );

      expect(exitCode).toBe(0);
      const record = JSON.parse(stdout.text().split("\n").filter((line) => line.length > 0)[0]!);
      expect(record.status).toBe("passed");
      expect(record.target_version).toBeUndefined();

      expect(stderr.text()).toContain(
        'Warning: version probe for environment "probe-throws" failed: probe boom',
      );
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
