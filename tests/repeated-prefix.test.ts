import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PickleStepArgument } from "@cucumber/messages";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeTend } from "../src/tend/analyze.js";
import { findRepeatedScenarioPrefixes, stepPrefixKey } from "../src/tend/repeated-prefix.js";
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
  readonly line?: number;
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
      ...(input.line === undefined ? {} : { line: input.line }),
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

const SHARED_FEATURE = [
  "Feature: shared openings",
  "",
  "  Scenario: alpha first",
  "    Given a list",
  '      """',
  "      alpha",
  '      """',
  "    When the list is read",
  "    Then it is shown",
  "",
  "  Scenario: beta",
  "    Given a list",
  '      """',
  "      beta",
  '      """',
  "    When the list is read",
  "    Then it is shown",
  "",
  "  Scenario: alpha again",
  "    Given a list",
  '      """',
  "      alpha",
  '      """',
  "    When the list is read",
  "    Then it is shown",
  "",
  "  Scenario Outline: posting",
  "    When the body is posted",
  '      """',
  "      <body>",
  '      """',
  "    Then the status is <status>",
  "",
  "    Examples:",
  "      | body | status |",
  "      | a    | 200    |",
  "      | b    | 400    |",
  "",
].join("\n");

const LIST_STEPS = [
  { text: "a list", ms: 3_000 },
  { text: "the list is read", ms: 3_000 },
  { text: "it is shown", ms: 1_000 },
];

describe("nuka tend: repeated-scenario-prefix reads the scenario's own steps", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("check-clean-project");
    await writeFile(path.join(rootDir, "features", "shared.feature"), SHARED_FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  async function prefixNotes() {
    return (await analyzeTend(rootDir)).notes.filter((note) => note.code === "repeated-scenario-prefix");
  }

  it("does not group a sentence whose docstring differs", async () => {
    for (const [id, line] of [["scn-alpha", 3], ["scn-beta", 11]] as const) {
      await writeScenario(rootDir, {
        id, runId: "run-new", feature: "features/shared.feature", line,
        startedAt: "2026-08-30T00:00:00.000Z", durationMs: 10_000, steps: LIST_STEPS,
      });
    }
    expect(await prefixNotes()).toEqual([]);
  });

  it("groups the same sentence and docstring, up to the first When, and says the docstring is shared", async () => {
    for (const [id, line] of [["scn-alpha", 3], ["scn-again", 19]] as const) {
      await writeScenario(rootDir, {
        id, runId: "run-new", feature: "features/shared.feature", line,
        startedAt: "2026-08-30T00:00:00.000Z", durationMs: 10_000, steps: LIST_STEPS,
      });
    }
    const notes = await prefixNotes();
    expect(notes.map((note) => note.message)).toEqual([
      "2 scenarios begin with the same 1 step, which took 6 seconds across them, 30% of this run's summed " +
        'scenario time. The shared steps: "a list". The shared steps take the same docstring or table. ' +
        'The place to lift a shared opening into is a "process"-scope fixture (nukadoko.config.ts fixtures); ' +
        "whether these scenarios can share what it builds depends on which of them write to that state, " +
        "which this tool cannot see.",
    ]);
  });

  it("does not report the When an outline's rows share", async () => {
    for (const [id, line] of [["row-a", 36], ["row-b", 37]] as const) {
      await writeScenario(rootDir, {
        id, runId: "run-new", feature: "features/shared.feature", line,
        startedAt: "2026-08-30T00:00:00.000Z", durationMs: 10_000,
        steps: [
          { text: "the body is posted", ms: 5_000 },
          { text: `the status is ${id === "row-a" ? 200 : 400}`, ms: 1_000 },
        ],
      });
    }
    expect(await prefixNotes()).toEqual([]);
  });
});

const argument = gs.oneOf<PickleStepArgument | undefined>(
  gs.just(undefined),
  gs.tuples(gs.oneOf(gs.just(undefined), gs.sampledFrom(["json", "text"])), gs.text({ maxSize: 6, alphabet: "ab\n\"" }))
    .map(([mediaType, content]): PickleStepArgument => ({ docString: mediaType === undefined ? { content } : { mediaType, content } })),
  gs.arrays(gs.arrays(gs.text({ maxSize: 3, alphabet: "ab|," }), { minSize: 1, maxSize: 2 }), { minSize: 1, maxSize: 3 })
    .map((rows): PickleStepArgument => ({ dataTable: { rows: rows.map((cells) => ({ cells: cells.map((value) => ({ value })) })) } })),
);
const prefixStep = gs.tuples(gs.sampledFrom(["a list", "a list ", "the list"]), argument)
  .map(([text, arg]) => (arg === undefined ? { text } : { text, argument: arg }));

describe("stepPrefixKey", () => {
  it("gives two steps the same key exactly when their text and argument are the same", () =>
    hegel.test((tc) => {
      const a = tc.draw(prefixStep);
      const b = tc.draw(prefixStep);
      expect(stepPrefixKey(a) === stepPrefixKey(b)).toBe(JSON.stringify(a) === JSON.stringify(b));
    }));
});
