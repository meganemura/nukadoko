import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the builtin `scratch` fixture through the real executors.
// `nuka run` removes the directories at the end of each scenario, whether it
// passed or failed, and the step record names them. A project fixture
// named `scratch` replaces the builtin.

interface ScenarioLine {
  readonly status: string;
  readonly steps: readonly { readonly step_record_id: string }[];
}

interface CopyStepRecord {
  readonly status: string;
  readonly result: { readonly copy: string; readonly empty: string; readonly copied: boolean };
  readonly evidence: { readonly scratch?: readonly string[] };
}

describe("nuka run: the builtin scratch fixture", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("scratch-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("lists each directory on the step record and removes it when the scenario ends, passed or failed", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/scratch.feature"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    const scenarios = stdout
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ScenarioLine);
    expect(scenarios.map((scenario) => scenario.status)).toEqual(["passed", "failed"]);

    for (const scenario of scenarios) {
      const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", scenario.steps[0]!.step_record_id, "record.json");
      const record = JSON.parse(await readFile(recordPath, "utf8")) as CopyStepRecord;
      expect(record.status).toBe("ok");
      expect(record.result.copied).toBe(true);
      expect(record.evidence.scratch).toEqual([record.result.copy, record.result.empty]);
      expect(path.basename(record.result.empty)).toMatch(/^empty-/);
      expect(existsSync(record.result.copy)).toBe(false);
      expect(existsSync(record.result.empty)).toBe(false);
    }
  });

  it("removes the directories after nuka do too", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "copy-of", "--args", '{"source":"seed"}'], { rootDir, stdout, stderr });

    expect(stderr.text()).toBe("");
    expect(exitCode).toBe(0);
    const record = JSON.parse(stdout.text()) as CopyStepRecord;
    expect(record.evidence.scratch).toEqual([record.result.copy, record.result.empty]);
    expect(existsSync(record.result.copy)).toBe(false);
  });
});

describe("nuka do: a project fixture named scratch replaces the builtin", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("scratch-override-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("hands the step the project's own value and records no scratch directory", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "names-a-dir", "--args", "{}"], { rootDir, stdout, stderr });

    expect(stderr.text()).toBe("");
    expect(exitCode).toBe(0);
    const record = JSON.parse(stdout.text()) as { result: { dir: string }; evidence: { scratch?: unknown } };
    expect(record.result.dir).toBe("project-x");
    expect(record.evidence.scratch).toBeUndefined();
  });
});
