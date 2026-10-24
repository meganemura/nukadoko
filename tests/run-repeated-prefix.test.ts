import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PickleStepArgument } from "@cucumber/messages";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { loadFeaturesFromDirs } from "../src/feature/load-features.js";
import { findRepeatedScenarioPrefixes, stepPrefixKey, type RunFeature } from "../src/run/repeated-prefix.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: verify the measured repeated-prefix note at its run.json
// and step record boundary, and that `nuka run` reports it. These tests do
// not inspect the trie used to group scenario steps.

interface StepInput {
  readonly text: string;
  readonly ms: number;
  readonly record?: boolean;
  readonly mutates?: boolean | null;
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

function runJsonPath(rootDir: string, runId: string): string {
  return path.join(rootDir, ".nukadoko", "runs", runId, "run.json");
}

/** Appends one scenario to its run's run.json, writing the step records it
 * cites. A run starts at its earliest scenario. */
function writeScenario(rootDir: string, input: ScenarioInput): void {
  const steps = [];
  for (const [index, step] of input.steps.entries()) {
    const stepId = step.record === false ? null : `step-${input.id}-${index}`;
    steps.push({ text: step.text, status: "passed", step_record_id: stepId, record: stepId === null ? null : `steps/${stepId}` });
    if (stepId !== null) {
      const stepDir = path.join(rootDir, ".nukadoko", "runs", input.runId, "steps", stepId);
      mkdirSync(stepDir, { recursive: true });
      const startedAt = Date.parse(input.startedAt) + index * 1_000;
      writeFileSync(
        path.join(stepDir, "record.json"),
        JSON.stringify({
          started_at: new Date(startedAt).toISOString(),
          finished_at: new Date(startedAt + step.ms).toISOString(),
          ...(step.mutates === undefined ? {} : { mutates: step.mutates }),
        }),
      );
    }
  }

  const filePath = runJsonPath(rootDir, input.runId);
  const run = existsSync(filePath)
    ? JSON.parse(readFileSync(filePath, "utf8"))
    : { command: "run", verdict: "passed", run_id: input.runId, started_at: input.startedAt, scenarios: [] };
  if (Date.parse(input.startedAt) < Date.parse(run.started_at)) run.started_at = input.startedAt;
  run.scenarios.push({
    scenario_record_id: input.id,
    feature: input.feature,
    line: input.line ?? 1,
    scenario: input.id,
    status: "passed",
    started_at: input.startedAt,
    finished_at: new Date(Date.parse(input.startedAt) + input.durationMs).toISOString(),
    steps,
  });
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(run));
}

/** The notes for the scenarios `writeScenario` wrote under `runId`, as
 * `nuka run` computes them from its own entries before run.json. */
function prefixNotes(rootDir: string, features: readonly RunFeature[] = [], runId = "run-new") {
  const filePath = runJsonPath(rootDir, runId);
  const scenarios = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")).scenarios : [];
  return findRepeatedScenarioPrefixes(path.dirname(filePath), scenarios, features);
}

describe("repeated-scenario-prefix", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("check-clean-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("collapses a three-level nested family to the prefix that covers the most step executions", async () => {
    const shared = [
      { text: "Given an account", ms: 1_000 },
      { text: "And the dashboard is open", ms: 2_000 },
      { text: "And the report is loaded", ms: 3_000 },
    ];
    writeScenario(rootDir, {
      id: "scn-a", runId: "run-new", feature: "features/a.feature",
      startedAt: "2026-08-30T00:00:00.000Z", durationMs: 10_000, steps: shared,
    });
    writeScenario(rootDir, {
      id: "scn-b", runId: "run-new", feature: "features/b.feature",
      startedAt: "2026-08-30T00:00:01.000Z", durationMs: 10_000, steps: shared,
    });

    const notes = prefixNotes(rootDir);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ severity: "note", code: "repeated-scenario-prefix", file: "features/a.feature" });
    expect(notes[0]!.message).toContain("2 scenarios");
    expect(notes[0]!.message).toContain("the same 3 steps");
    expect(notes[0]!.message).toContain("12 seconds");
    expect(notes[0]!.message).toContain("60%");
    expect(notes[0]!.message).toContain("Given an account");
    expect(notes[0]!.message).toContain("And the report is loaded");
  });

  it("does not report a repeated prefix below two percent of the run time", async () => {
    for (const id of ["scn-a", "scn-b"]) {
      writeScenario(rootDir, {
        id, runId: "run-new", feature: `features/${id}.feature`,
        startedAt: `2026-08-30T00:00:0${id === "scn-a" ? 0 : 1}.000Z`,
        durationMs: 10_000, steps: [{ text: "Given a cheap opening", ms: 100 }],
      });
    }
    expect(prefixNotes(rootDir)).toEqual([]);
  });

  it("returns no notes when the run has no scenarios", () => {
    expect(prefixNotes(rootDir)).toEqual([]);
  });

  it("returns no notes when every prefix belongs to only one scenario", async () => {
    writeScenario(rootDir, {
      id: "scn-a", runId: "run-new", feature: "features/a.feature",
      startedAt: "2026-08-30T00:00:00.000Z", durationMs: 10_000,
      steps: [{ text: "Given a unique opening", ms: 5_000 }],
    });
    expect(prefixNotes(rootDir)).toEqual([]);
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

describe("repeated-scenario-prefix reads the scenario's own steps", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("check-clean-project");
    await writeFile(path.join(rootDir, "features", "shared.feature"), SHARED_FEATURE);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  function sharedNotes() {
    return prefixNotes(rootDir, loadFeaturesFromDirs(rootDir, "features", []).features);
  }

  it("does not group a sentence whose docstring differs", async () => {
    for (const [id, line] of [["scn-alpha", 3], ["scn-beta", 11]] as const) {
      writeScenario(rootDir, {
        id, runId: "run-new", feature: "features/shared.feature", line,
        startedAt: "2026-08-30T00:00:00.000Z", durationMs: 10_000, steps: LIST_STEPS,
      });
    }
    expect(sharedNotes()).toEqual([]);
  });

  it("groups the same sentence and docstring, up to the first When, and says the docstring is shared", async () => {
    for (const [id, line] of [["scn-alpha", 3], ["scn-again", 19]] as const) {
      writeScenario(rootDir, {
        id, runId: "run-new", feature: "features/shared.feature", line,
        startedAt: "2026-08-30T00:00:00.000Z", durationMs: 10_000, steps: LIST_STEPS,
      });
    }
    const notes = sharedNotes();
    expect(notes.map((note) => note.message)).toEqual([
      "2 scenarios begin with the same 1 step, which took 6 seconds across them, 30% of this run's summed " +
        'scenario time. The shared steps: "a list". The shared steps take the same docstring or table. ' +
        '"a list" does not declare mutates: false, so a later scenario may read what this opening writes: ' +
        'a "process"-scope fixture would share that state between scenarios. ' +
        "A Background keeps the shared steps in one place and still runs them for each scenario.",
    ]);
  });

  it("does not report the When an outline's rows share", async () => {
    for (const [id, line] of [["row-a", 36], ["row-b", 37]] as const) {
      writeScenario(rootDir, {
        id, runId: "run-new", feature: "features/shared.feature", line,
        startedAt: "2026-08-30T00:00:00.000Z", durationMs: 10_000,
        steps: [
          { text: "the body is posted", ms: 5_000 },
          { text: `the status is ${id === "row-a" ? 200 : 400}`, ms: 1_000 },
        ],
      });
    }
    expect(sharedNotes()).toEqual([]);
  });
});

describe("repeated-scenario-prefix names an opening that timing does not decide", () => {
  const permutations = (items: readonly string[]): string[][] =>
    items.length === 0 ? [[]] : items.flatMap((item, index) =>
      permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
  const recordIdOrders = permutations(["scn-1", "scn-2", "scn-3", "scn-4"]);
  const stepMs = gs.integers({ minValue: 500, maxValue: 1_500 });

  it("names the same opening and file whatever each step took and whatever order the records sort in", () =>
    hegel.test((tc) => {
      const ids = tc.draw(gs.sampledFrom(recordIdOrders));
      const shapes: readonly { feature: string; line: number; texts: readonly string[] }[] = [
        { feature: "features/b.feature", line: 3, texts: ["Given an account", "And a saved report", "When it is read"] },
        { feature: "features/a.feature", line: 9, texts: ["Given an account", "And a saved report", "When it is shared"] },
        { feature: "features/a.feature", line: 3, texts: ["Given an account", "When it is closed"] },
        { feature: "features/c.feature", line: 3, texts: ["Given nothing", "When it starts"] },
      ];
      const rootDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-prefix-"));
      try {
        for (const [index, shape] of shapes.entries()) {
          const steps = shape.texts.map((text) => ({ text, ms: tc.draw(stepMs) }));
          writeScenario(rootDir, {
            id: ids[index]!, runId: "run-new", feature: shape.feature, line: shape.line,
            startedAt: `2026-08-30T00:00:0${index}.000Z`,
            durationMs: steps.reduce((total, step) => total + step.ms, 0),
            steps,
          });
        }
        const notes = prefixNotes(rootDir);
        expect(notes.map((note) => [note.file, note.message.split(", which took")[0]])).toEqual([
          ["features/a.feature", "2 scenarios begin with the same 2 steps"],
        ]);
        expect(notes[0]!.message).toContain('The shared steps: "Given an account", "And a saved report".');
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    }));
});

describe("repeated-scenario-prefix reads each shared step's mutates declaration", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("check-clean-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  function writePair(mutates: readonly (boolean | null)[]): void {
    for (const id of ["scn-a", "scn-b"]) {
      writeScenario(rootDir, {
        id, runId: "run-new", feature: `features/${id}.feature`,
        startedAt: "2026-08-30T00:00:00.000Z", durationMs: 10_000,
        steps: [
          { text: "Given the catalog is loaded", ms: 2_000, mutates: mutates[0]! },
          { text: "And the dashboard is open", ms: 2_000, mutates: mutates[1]! },
        ],
      });
    }
  }

  it("names a process-scope fixture when every shared step declares mutates: false", () => {
    writePair([false, false]);
    expect(prefixNotes(rootDir).map((note) => note.message)).toEqual([
      "2 scenarios begin with the same 2 steps, which took 8 seconds across them, 40% of this run's summed " +
        'scenario time. The shared steps: "Given the catalog is loaded", "And the dashboard is open". ' +
        'Every shared step declares mutates: false, so a "process"-scope fixture (nukadoko.config.ts fixtures) ' +
        "can build this opening once for all of them.",
    ]);
  });

  it("names the first shared step that may write, and does not offer a process-scope fixture for it", () => {
    writePair([false, true]);
    expect(prefixNotes(rootDir).map((note) => note.message)).toEqual([
      "2 scenarios begin with the same 2 steps, which took 8 seconds across them, 40% of this run's summed " +
        'scenario time. The shared steps: "Given the catalog is loaded", "And the dashboard is open". ' +
        '"And the dashboard is open" does not declare mutates: false, so a later scenario may read what this ' +
        'opening writes: a "process"-scope fixture would share that state between scenarios. ' +
        "A Background keeps the shared steps in one place and still runs them for each scenario.",
    ]);
  });

  it("treats a compat step, which declares no mutates, as one that may write", () => {
    writePair([null, false]);
    expect(prefixNotes(rootDir)[0]!.message).toContain(
      '"Given the catalog is loaded" does not declare mutates: false',
    );
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

describe("nuka run: repeated-scenario-prefix", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("check-clean-project");
    await writeFile(
      path.join(rootDir, "features", "steps", "load-catalog.ts"),
      [
        'import { z } from "zod";',
        'import { defineStep } from "../../nukadoko-shim.js";',
        "",
        "export default defineStep({",
        '  pattern: "the catalog is loaded",',
        '  description: "Load the catalog, slowly",',
        "  args: z.object({}),",
        "  returns: z.object({}),",
        "  mutates: false,",
        "  async run() {",
        "    await new Promise((resolve) => setTimeout(resolve, 200));",
        "    return {};",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(rootDir, "features", "catalog.feature"),
      [
        "Feature: catalog",
        "",
        "  Scenario: first lookup",
        "    Given the catalog is loaded",
        '    Then the project "acme" can be looked up',
        "",
        "  Scenario: second lookup",
        "    Given the catalog is loaded",
        '    Then the project "beta" can be looked up',
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("adds the note to run.json and to the text at the end of the run, and keeps the exit code 0", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/catalog.feature"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    const notes = latestRunJson(rootDir).findings.filter((finding: { code: string }) => finding.code === "repeated-scenario-prefix");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ severity: "note", file: "features/catalog.feature" });
    expect(notes[0].message).toContain('2 scenarios begin with the same 1 step');
    expect(notes[0].message).toContain('Every shared step declares mutates: false');
    expect(stderr.text()).toMatch(/^note\trepeated-scenario-prefix\tfeatures\/catalog\.feature\t2 scenarios begin/m);
  });
});
