import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parseFeatureSource } from "../src/feature/load-features.js";
import type { ScenarioRecord, ScenarioStepEntry } from "../src/record/scenario-record.js";
import type { StepRecord } from "../src/record/types.js";
import { buildRunScenario, gherkinStepLines, pickleStepLines } from "../src/run/run-document.js";

// Responsibility: one scenario's run.json entry, built from the scenario as
// it ran and the step records it cites, and the line of each step in its
// feature file.

function stepRecord(id: string, status: "passed" | "failed", used: boolean): StepRecord {
  const base = {
    schema_version: 2 as const,
    nukadoko: "0.17.0",
    step_record_id: id,
    step: "a-step",
    kind: "run" as const,
    args: {},
    environment: "default",
    session: null,
    scenario_record_id: "scn-1",
    run_id: "run-1",
    started_at: "2026-10-18T00:00:00.000Z",
    finished_at: "2026-10-18T00:00:01.000Z",
    evidence: { dir: `.nukadoko/records/steps/${id}`, screenshots: [] },
    observed: { http_reads: 1, http_writes: 0, processes: null },
    mutates: false,
  };
  return status === "passed"
    ? { ...base, status, result: null }
    : {
        ...base,
        status,
        error: { message: "boom", kind: "step_error" },
        ...(used ? { used: [{ step_record_id: "step-0", step: "producer", result: { exitCode: 0 } }] } : {}),
      };
}

function record(steps: ScenarioStepEntry[], status: "passed" | "failed", screenshot = false): ScenarioRecord {
  return {
    nukadoko: "0.17.0",
    scenario_record_id: "scn-1",
    run_id: "run-1",
    feature: "features/a.feature",
    scenario: "a scenario",
    line: 3,
    status,
    environment: "default",
    session: null,
    started_at: "2026-10-18T00:00:00.000Z",
    finished_at: "2026-10-18T00:00:02.000Z",
    steps,
    hooks: [],
    evidence: {
      dir: ".nukadoko/records/scenarios/scn-1",
      screenshots: screenshot ? [{ file: "final.png", at: "2026-10-18T00:00:02.000Z" }] : [],
    },
  };
}

describe("buildRunScenario", () => {
  it("builds one entry per step, with a record path exactly when a step record exists, and a `do` exactly when the scenario failed, and evidence exactly when the scenario wrote some", () =>
    hegel.test((tc) => {
      const drawn = tc.draw(
        gs.arrays(
          gs.tuples(
            gs.sampledFrom(["passed", "failed", "skipped", "undefined", "ambiguous"] as const),
            gs.booleans(),
            gs.booleans(),
          ),
          { maxSize: 8 },
        ),
      );
      const status = tc.draw(gs.sampledFrom(["passed", "failed"] as const));
      const screenshot = tc.draw(gs.booleans());
      const stepRecords = new Map<string, StepRecord | null>();
      const steps: ScenarioStepEntry[] = drawn.map(([stepStatus, hasRecord, used], index) => {
        const id = hasRecord ? `step-${index + 1}` : null;
        if (id !== null) stepRecords.set(id, stepRecord(id, stepStatus === "failed" ? "failed" : "passed", used));
        return {
          text: `step ${index}`,
          status: stepStatus,
          step_record_id: id,
          ...(stepStatus === "passed" || stepStatus === "skipped" ? {} : { error: { message: `error ${index}` } }),
        };
      });
      const entry = buildRunScenario(record(steps, status, screenshot), {
        stepRecords,
        stepLine: (index) => index + 10,
        stepName: (text) => `name of ${text}`,
        recordPath: (id) => `.nukadoko/records/steps/${id}`,
        rerun: "nuka run features/a.feature:3",
      });

      expect(entry.steps).toHaveLength(steps.length);
      expect(entry.do).toBe(status === "failed" ? "nuka run features/a.feature:3" : undefined);
      expect(entry.evidence?.screenshots).toEqual(screenshot ? [{ file: "final.png", at: "2026-10-18T00:00:02.000Z" }] : undefined);
      entry.steps.forEach((built, index) => {
        const [stepStatus, hasRecord, used] = drawn[index]!;
        expect(built.line).toBe(index + 10);
        expect(built.step).toBe(`name of step ${index}`);
        expect(built.status).toBe(stepStatus);
        expect(built.step_record_id).toBe(hasRecord ? `step-${index + 1}` : null);
        expect(built.record).toBe(hasRecord ? `.nukadoko/records/steps/step-${index + 1}` : null);
        expect(built.mutates).toBe(hasRecord ? false : undefined);
        const failedWithRecord = hasRecord && stepStatus === "failed";
        expect(built.error).toEqual(
          stepStatus === "passed" || stepStatus === "skipped"
            ? undefined
            : { kind: failedWithRecord ? "step_error" : null, message: `error ${index}` },
        );
        expect(built.used).toEqual(
          failedWithRecord && used
            ? [{ step: "producer", record: ".nukadoko/records/steps/step-0", result: { exitCode: 0 } }]
            : undefined,
        );
      });
    }));
});

describe("pickleStepLines", () => {
  it("names the line of a Background step, a Scenario step, and an Outline step for each Examples row", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(
      [
        "Feature: f",
        "  Background:",
        "    Given a base",
        "",
        "  Scenario: one",
        "    When it runs",
        "",
        "  Scenario Outline: two",
        "    Then it says <word>",
        "",
        "    Examples:",
        "      | word |",
        "      | hi   |",
        "      | bye  |",
        "",
      ].join("\n"),
      "features/f.feature",
    );
    const lines = gherkinStepLines(gherkinDocument);
    expect(pickles.map((pickle) => pickle.steps.map((_, index) => pickleStepLines(pickle, lines)(index)))).toEqual([
      [3, 6],
      [3, 9],
      [3, 9],
    ]);
    expect(pickleStepLines(pickles[0]!, lines)(5)).toBe(null);
  });
});
