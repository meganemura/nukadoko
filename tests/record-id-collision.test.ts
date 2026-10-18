import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a record id that is already taken on disk never makes two
// records share one directory. Ids carry four random characters per second,
// so a fast run can draw the same id twice; the id sources are replaced here
// so the duplicate happens on every run instead of by chance.

const queued = vi.hoisted(() => ({ step: [] as string[], scenario: [] as string[] }));

vi.mock("../src/record/record-id.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/record/record-id.js")>();
  return {
    ...original,
    generateStepRecordId: () => queued.step.shift() ?? original.generateStepRecordId(),
  };
});

vi.mock("../src/run/scenario-id.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/run/scenario-id.js")>();
  return {
    ...original,
    generateScenarioId: () => queued.scenario.shift() ?? original.generateScenarioId(),
  };
});

const duplicateStepId = "step-20260101-000000-dupe";
const duplicateScenarioId = "scn-20260101-000000-dupe";

async function recordIdsOnDisk(rootDir: string, kind: "steps" | "scenarios"): Promise<string[]> {
  const dir = path.join(rootDir, ".nukadoko", "records", kind);
  const ids: string[] = [];
  for (const name of await readdir(dir)) {
    const record = JSON.parse(await readFile(path.join(dir, name, "record.json"), "utf8"));
    ids.push(kind === "steps" ? record.step_record_id : record.scenario_record_id);
  }
  return ids.sort();
}

describe("a record id already taken on disk", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("record-id-collision-project");
  });

  afterEach(async () => {
    queued.step.length = 0;
    queued.scenario.length = 0;
    await removeTempDir(rootDir);
  });

  it("gives every step and scenario of nuka run its own record directory", async () => {
    queued.step.push(duplicateStepId, duplicateStepId, duplicateStepId);
    queued.scenario.push(duplicateScenarioId, duplicateScenarioId);
    const stdout = createCaptureSink();

    const exitCode = await runCli(["run", "--records", "features/notes.feature"], { rootDir, stdout, stderr: createCaptureSink() });

    expect(exitCode).toBe(0);
    const scenarios = stdout
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    const scenarioIds = scenarios.map((record) => record.scenario_record_id as string);
    const stepIds = scenarios.flatMap((record) => record.steps.map((step: { step_record_id: string }) => step.step_record_id));
    expect(new Set(scenarioIds).size).toBe(2);
    expect(new Set(stepIds).size).toBe(3);
    expect(await recordIdsOnDisk(rootDir, "scenarios")).toEqual([...scenarioIds].sort());
    expect(await recordIdsOnDisk(rootDir, "steps")).toEqual([...stepIds].sort());
  });

  it("gives a second nuka do its own record directory", async () => {
    queued.step.push(duplicateStepId, duplicateStepId);

    for (const text of ["a", "b"]) {
      const exitCode = await runCli(["do", "note", "--args", JSON.stringify({ text })], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      });
      expect(exitCode).toBe(0);
    }

    const ids = await recordIdsOnDisk(rootDir, "steps");
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(duplicateStepId);
    expect(ids[1]).not.toBe(duplicateStepId);
  });
});
