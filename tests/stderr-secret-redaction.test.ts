import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a secret the suite loaded from an untracked env file must
// not reach stderr inside a fixture teardown message or a version-probe
// failure. `nuka do` prints both raw. `nuka run` prints a process-scope
// teardown raw (a scenario-scope one is already redacted with the scenario
// record) and prints the probe failure before the SecretSet exists.
// `--concurrency` above 1 repeats both writes in the worker.

const API_TOKEN = "SECRETTOKEN123456";

function expectSecretRedacted(stderr: string): void {
  expect(stderr).toContain('Warning: fixture "leakyTeardown" teardown failed');
  expect(stderr).toContain('Warning: version probe for environment "default" failed');
  expect(stderr).not.toContain(API_TOKEN);
  expect(stderr).toContain("{{secret.API_TOKEN}}");
}

describe("stderr redacts a suite secret in teardown and version-probe failures", () => {
  it("nuka do: the teardown warning and the probe warning omit the secret", async () => {
    const rootDir = await copyFixtureToTempDir("stderr-redaction-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["do", "uses-leaky-fixture", "--args", "{}"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.text()).status).toBe("ok");
      expectSecretRedacted(stderr.text());
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("nuka run: the process-scope teardown warning and the probe warning omit the secret", async () => {
    const rootDir = await copyFixtureToTempDir("stderr-redaction-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "features/leak-a.feature"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      const record = JSON.parse(stdout.text().split("\n").filter((line) => line.length > 0)[0]!);
      expect(record.status).toBe("passed");
      expectSecretRedacted(stderr.text());
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("nuka run --concurrency 2: worker teardown and probe warnings omit the secret", async () => {
    const rootDir = await copyFixtureToTempDir("stderr-redaction-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "features/", "--concurrency", "2"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(stderr.text()).not.toContain("--concurrency has nothing to distribute");
      const records = stdout.text().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
      expect(records).toHaveLength(2);
      expect(records.every((record) => record.status === "passed")).toBe(true);
      expectSecretRedacted(stderr.text());
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
