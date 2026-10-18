import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { readStepRecord } from "../src/record/read-step-record.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a step body that does `await import("./lib/x.js")` of a
// TypeScript file must resolve it, because discovery's TypeScript loader
// registration stays active until the command that runs the steps is over.

describe("a dynamic import of a TypeScript file inside a step body", () => {
  it("resolves under nuka run", async () => {
    const rootDir = await copyFixtureToTempDir("lazy-import-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["run", "--records", "features/lazy.feature"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(0);
      const scenarioRecord = JSON.parse(stdout.text().split("\n")[0]!);
      expect(scenarioRecord.status).toBe("passed");
      const stepRecord = readStepRecord(
        path.join(rootDir, ".nukadoko", "records", "steps", scenarioRecord.steps[0].step_record_id),
      );
      expect((stepRecord as { result?: unknown } | null)?.result).toEqual({ greeting: "hello ada" });
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("resolves under nuka do", async () => {
    const rootDir = await copyFixtureToTempDir("lazy-import-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["do", "greet-lazily", "--args", '{"name":"ada"}'], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(0);
      expect(stdout.text()).toContain("hello ada");
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
