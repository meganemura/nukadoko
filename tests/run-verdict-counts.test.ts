import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the count lines `nuka run` ends with, against
// tests/fixtures/run-verdict-hooks-project. The scenario line counts the
// required cells alone, and a run with a control counts its controls on
// a line of their own, so a control, which may fail by design, never
// reads as a scenario that failed or did not run.

describe("nuka run: the count lines", () => {
  it("counts the required cells that did not run apart from the controls that did not", async () => {
    const rootDir = await copyFixtureToTempDir("run-verdict-hooks-project");
    try {
      // BeforeAll call 1 is flag-off's, so none of flag-off's cells run:
      // two required (banner.feature:8, value.feature:3) and two controls.
      writeFileSync(path.join(rootDir, "hooks.json"), JSON.stringify({ beforeAll: [1] }));
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run"], { rootDir, stdout: createCaptureSink(), stderr });
      expect(exitCode).toBe(1);
      expect(latestRunJson(rootDir).counts).toEqual({ scenarios: 3, passed: 3, failed: 0, not_run: 2, controls: 2, controls_not_run: 2 });
      expect(stderr.text()).toMatch(/^3 scenarios: 3 passed, 0 failed, 2 not run {2}\(\d+s\)\n2 control runs, 2 not run\ncriteria: 2 held, 0 proven, 2 failed\n/m);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("writes no control line for a run with no control", async () => {
    const rootDir = await copyFixtureToTempDir("run-verdict-hooks-project");
    try {
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "--env", "flag-on", "features/value.feature:3"], { rootDir, stdout: createCaptureSink(), stderr });
      expect(exitCode).toBe(0);
      expect(stderr.text()).toMatch(/^1 scenario: 1 passed, 0 failed {2}\(\d+s\)\n/m);
      expect(stderr.text()).not.toContain("control run");
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
