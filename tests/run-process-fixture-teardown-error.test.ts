import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run`'s own "process"-scope fixture teardown warning
// (cli/run.ts, after the whole pickle loop). The "scenario"-scope sibling
// of this same shape is tests/run-fixture-teardown-error.test.ts's own
// (that fixture's own teardown_errors lands on the ScenarioRecord itself,
// since it tears down per scenario); a "process"-scope fixture tears down
// once, after every scenario in the run, and has no ScenarioRecord of its
// own to land on, so it is announced on stderr only. Against
// tests/fixtures/run-process-fixture-teardown-error-project.

describe("nuka run: a process-scope fixture whose own teardown fails", () => {
  it("keeps the scenario passed, and warns on stderr naming the fixture and message", async () => {
    const rootDir = await copyFixtureToTempDir("run-process-fixture-teardown-error-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "features/teardown.feature"], {
        rootDir,
        stdout,
        stderr,
      });

      // A teardown failure never fails the run on its own.
      expect(exitCode).toBe(0);
      const record = JSON.parse(stdout.text().split("\n").filter((line) => line.length > 0)[0]!);
      expect(record.status).toBe("passed");

      expect(stderr.text()).toContain('Warning: fixture "brokenProcessTeardown" teardown failed');
      expect(stderr.text()).toContain("brokenProcessTeardown's own teardown exploded on purpose");
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
