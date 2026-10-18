import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run`'s own version-probe call (cli/run.ts's own
// probeVersion() call): both the success case (records target_version in
// run.json) and the failure case (warns on stderr and in run.json's
// findings, still runs the scenario). tests/environment.test.ts already proves both shapes for
// `nuka do`'s own separate probeVersion() call site; exercised here through
// `nuka run` instead, against a fixture dedicated to this one call site
// (tests/fixtures/environments-project has no .feature file of its own,
// since every test against it drives `nuka do`, which addresses a step by
// name).

describe("nuka run: an environment's own version probe", () => {
  it("records target_version in run.json when the probe succeeds", async () => {
    const rootDir = await copyFixtureToTempDir("run-version-probe-warning-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(
        ["run", "features/noop.feature", "--env", "probe-ok"],
        { rootDir, stdout, stderr },
      );

      expect(exitCode).toBe(0);
      expect(stderr.text()).not.toContain("version-probe-failed");
      const document = latestRunJson(rootDir);
      expect(document.counts).toEqual({ scenarios: 1, passed: 1, failed: 0 });
      expect(document.target_version).toBe("9.9.9");
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
      const document = latestRunJson(rootDir);
      expect(document.counts).toEqual({ scenarios: 1, passed: 1, failed: 0 });
      expect(document.target_version).toBe(null);
      expect(document.findings).toEqual([
        {
          severity: "warning",
          code: "version-probe-failed",
          message: 'version probe for environment "probe-throws" failed: probe boom',
          fix: "Correct the environment's version setting in the config file, or the endpoint it names.",
        },
      ]);

      expect(stderr.text()).toContain(
        'warning\tversion-probe-failed\t-\tversion probe for environment "probe-throws" failed: probe boom',
      );
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
