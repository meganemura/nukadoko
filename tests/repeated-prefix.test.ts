import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeTend } from "../src/tend/analyze.js";
import { findRepeatedScenarioPrefixes } from "../src/tend/repeated-prefix.js";
import { copyFixtureToTempDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: verify the measured repeated-prefix note at its record-file
// boundary. These tests do not inspect the trie used to group scenario steps.

interface StepInput {
  readonly text: string;
  readonly ms: number;
  readonly record?: boolean;
}

interface ScenarioInput {
  readonly id: string;
  readonly runId: string;
  readonly feature: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly steps: readonly StepInput[];
}

async function writeScenario(rootDir: string, input: ScenarioInput): Promise<void> {
  const scenarioDir = path.join(rootDir, ".nukadoko", "records", "scenarios", input.id);
  await mkdir(scenarioDir, { recursive: true });

  const steps = [];
  for (const [index, step] of input.steps.entries()) {
    const stepId = step.record === false ? null : `step-${input.id}-${index}`;
    steps.push({ text: step.text, status: "passed", step_record_id: stepId });
    if (stepId !== null) {
      const stepDir = path.join(rootDir, ".nukadoko", "records", "steps", stepId);
      await mkdir(stepDir, { recursive: true });
      const startedAt = Date.parse(input.startedAt) + index * 1_000;
      await writeFile(
        path.join(stepDir, "record.json"),
        JSON.stringify({
          started_at: new Date(startedAt).toISOString(),
          finished_at: new Date(startedAt + step.ms).toISOString(),
        }),
      );
    }
  }

  const startedAt = Date.parse(input.startedAt);
  await writeFile(
    path.join(scenarioDir, "record.json"),
    JSON.stringify({
      scenario_record_id: input.id,
      run_id: input.runId,
      feature: input.feature,
      scenario: input.id,
      started_at: input.startedAt,
      finished_at: new Date(startedAt + input.durationMs).toISOString(),
      steps,
    }),
  );
}

describe("nuka tend: repeated-scenario-prefix", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("check-clean-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("collapses a three-level nested family to the prefix with the largest measured time", async () => {
    const shared = [
      { text: "Given an account", ms: 1_000 },
      { text: "And the dashboard is open", ms: 2_000 },
      { text: "And the report is loaded", ms: 3_000 },
    ];
    await writeScenario(rootDir, {
      id: "scn-a", runId: "run-new", feature: "features/a.feature",
      startedAt: "2026-08-30T00:00:00.000Z", durationMs: 10_000, steps: shared,
    });
    await writeScenario(rootDir, {
      id: "scn-b", runId: "run-new", feature: "features/b.feature",
      startedAt: "2026-08-30T00:00:01.000Z", durationMs: 10_000, steps: shared,
    });

    const report = await analyzeTend(rootDir);
    const notes = report.notes.filter((note) => note.code === "repeated-scenario-prefix");
    expect(report.errors.filter((error) => error.code === "repeated-scenario-prefix")).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ code: "repeated-scenario-prefix", file: "features/a.feature" });
    expect(notes[0]!.message).toContain("2 scenarios");
    expect(notes[0]!.message).toContain("the same 3 steps");
    expect(notes[0]!.message).toContain("12 seconds");
    expect(notes[0]!.message).toContain("60%");
    expect(notes[0]!.message).toContain("Given an account");
    expect(notes[0]!.message).toContain("And the report is loaded");
  });

  it("does not report a repeated prefix below two percent of the run time", async () => {
    for (const id of ["scn-a", "scn-b"]) {
      await writeScenario(rootDir, {
        id, runId: "run-new", feature: `features/${id}.feature`,
        startedAt: `2026-08-30T00:00:0${id === "scn-a" ? 0 : 1}.000Z`,
        durationMs: 10_000, steps: [{ text: "Given a cheap opening", ms: 100 }],
      });
    }
    expect(findRepeatedScenarioPrefixes(rootDir, ".nukadoko")).toEqual([]);
  });

  it("uses only the most recent run", async () => {
    for (const id of ["old-a", "old-b"]) {
      await writeScenario(rootDir, {
        id, runId: "run-old", feature: `features/${id}.feature`,
        startedAt: "2026-08-29T00:00:00.000Z", durationMs: 20_000,
        steps: [{ text: "Given an old expensive opening", ms: 8_000 }],
      });
    }
    for (const id of ["new-a", "new-b"]) {
      await writeScenario(rootDir, {
        id, runId: "run-new", feature: `features/${id}.feature`,
        startedAt: "2026-08-30T00:00:00.000Z", durationMs: 10_000,
        steps: [{ text: "Given a new opening", ms: 1_000 }],
      });
    }

    const notes = findRepeatedScenarioPrefixes(rootDir, ".nukadoko");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain("2 seconds");
    expect(notes[0]!.message).toContain("10%");
    expect(notes[0]!.message).not.toContain("old expensive");
  });

  it("returns no notes when the project has no scenario records", async () => {
    const report = await analyzeTend(rootDir);
    expect(report.notes.filter((note) => note.code === "repeated-scenario-prefix")).toEqual([]);
  });

  it("returns no notes when every prefix belongs to only one scenario", async () => {
    await writeScenario(rootDir, {
      id: "scn-a", runId: "run-new", feature: "features/a.feature",
      startedAt: "2026-08-30T00:00:00.000Z", durationMs: 10_000,
      steps: [{ text: "Given a unique opening", ms: 5_000 }],
    });
    expect(findRepeatedScenarioPrefixes(rootDir, ".nukadoko")).toEqual([]);
  });

  it("ignores a valid JSON scenario record whose shape cannot supply steps", async () => {
    const recordDir = path.join(rootDir, ".nukadoko", "records", "scenarios", "broken");
    await mkdir(recordDir, { recursive: true });
    await writeFile(
      path.join(recordDir, "record.json"),
      JSON.stringify({
        run_id: "run-new",
        started_at: "2026-08-30T00:00:00.000Z",
        finished_at: "2026-08-30T00:00:01.000Z",
      }),
    );
    expect(findRepeatedScenarioPrefixes(rootDir, ".nukadoko")).toEqual([]);
  });
});
