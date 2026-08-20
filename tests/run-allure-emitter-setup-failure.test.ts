import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run`'s own "Warning: allure emitter setup failed"
// branch (cli/run.ts): createAllureEmitter (src/report/allure/emitter.ts)
// calls mkdirSync(resultsDir, { recursive: true }) unguarded, which throws
// ENOTDIR when a path segment above resultsDir already exists as a plain
// file. src/report/allure/*.test.ts exercises the emitter directly; no test
// yet drives its own setup failure through `nuka run`'s own try/catch
// around it. Against tests/fixtures/run-allure-emitter-setup-failure-project,
// whose own config.allure.resultsDir this test blocks with a plain file.

describe("nuka run: the allure emitter's own setup fails", () => {
  it("warns on stderr, but still runs the scenario and writes its step record", async () => {
    const rootDir = await copyFixtureToTempDir("run-allure-emitter-setup-failure-project");
    try {
      // Blocks "blocked-by-a-file/allure-results" (this fixture's own
      // config.allure.resultsDir) one path segment above where the emitter
      // tries to mkdir: "blocked-by-a-file" now exists as a plain file, not
      // a directory.
      await writeFile(path.join(rootDir, "blocked-by-a-file"), "not a directory");

      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "features/noop.feature"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      const record = JSON.parse(stdout.text().split("\n").filter((line) => line.length > 0)[0]!);
      expect(record.status).toBe("passed");

      expect(stderr.text()).toContain("Warning: allure emitter setup failed");
      expect(stderr.text()).toContain("ENOTDIR");
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
