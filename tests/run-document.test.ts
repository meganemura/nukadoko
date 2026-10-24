import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parseFeatureSource } from "../src/feature/load-features.js";
import type { ScenarioRecord, ScenarioStepEntry } from "../src/record/scenario-record.js";
import type { StepRecord } from "../src/record/types.js";
import { USED_RESULT_MAX_BYTES, boundUsedResult, buildRunScenario, gherkinStepLines, pickleStepLines } from "../src/run/run-document.js";

// Responsibility: one scenario's run.json entry, built from the scenario as
// it ran and the step records it cites, and the line of each step in its
// feature file.

function stepRecord(id: string, status: "passed" | "failed", used: boolean): StepRecord {
  const base = {
    schema_version: 4 as const,
    nukadoko: "0.17.0",
    step_record_id: id,
    step: "a-step",
    kind: "run" as const,
    args: {},
    environment: "default",
    scenario_record_id: "scn-1",
    run_id: "run-1",
    started_at: "2026-10-18T00:00:00.000Z",
    finished_at: "2026-10-18T00:00:01.000Z",
    evidence: { dir: `.nukadoko/runs/run-1/steps/${id}`, screenshots: [] },
    observed: { processes: null },
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
    started_at: "2026-10-18T00:00:00.000Z",
    finished_at: "2026-10-18T00:00:02.000Z",
    steps,
    hooks: [],
    evidence: {
      dir: ".nukadoko/runs/run-1/scenarios/scn-1",
      screenshots: screenshot ? [{ file: "final.png", at: "2026-10-18T00:00:02.000Z" }] : [],
    },
  };
}

describe("buildRunScenario", () => {
  it("builds one entry per step, with a run-relative record path exactly when a step record exists, and a `do` exactly when the scenario failed, and evidence exactly when the scenario wrote some", () =>
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
        recordPath: (id) => `steps/${id}`,
        evidenceDir: "scenarios/scn-1",
        rerun: "nuka run features/a.feature:3",
      });

      expect(entry.steps).toHaveLength(steps.length);
      expect(entry.do).toBe(status === "failed" ? "nuka run features/a.feature:3" : undefined);
      expect(entry.evidence).toEqual(
        screenshot ? { dir: "scenarios/scn-1", screenshots: [{ file: "final.png", at: "2026-10-18T00:00:02.000Z" }] } : undefined,
      );
      entry.steps.forEach((built, index) => {
        const [stepStatus, hasRecord, used] = drawn[index]!;
        expect(built.line).toBe(index + 10);
        expect(built.step).toBe(`name of step ${index}`);
        expect(built.status).toBe(stepStatus);
        expect(built.step_record_id).toBe(hasRecord ? `step-${index + 1}` : null);
        expect(built.record).toBe(hasRecord ? `steps/step-${index + 1}` : null);
        expect(built.mutates).toBe(hasRecord ? false : undefined);
        const failedWithRecord = hasRecord && stepStatus === "failed";
        expect(built.error).toEqual(
          stepStatus === "passed" || stepStatus === "skipped"
            ? undefined
            : { kind: failedWithRecord ? "step_error" : null, message: `error ${index}` },
        );
        expect(built.used).toEqual(
          failedWithRecord && used
            ? [{ step: "producer", record: "steps/step-0", result: { exitCode: 0 } }]
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

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");

const result = gs.oneOf<unknown>(
  gs.text({ maxSize: 6000 }),
  gs.integers(),
  gs.booleans(),
  gs.just(null),
  gs.arrays(gs.text({ maxSize: 2000 }), { maxSize: 6 }),
  gs
    .tuples(gs.integers({ minValue: 0, maxValue: 255 }), gs.text({ maxSize: 6000 }), gs.text({ maxSize: 6000 }), gs.arrays(gs.text(), { maxSize: 4 }))
    .map(([exitCode, stdout, stderr, extra]) => ({ stdout, exitCode, stderr, extra })),
);

describe("boundUsedResult", () => {
  it("keeps a result that fits whole, and bounds one that does not, marking it", () =>
    hegel.test((tc) => {
      const value = tc.draw(result);
      const bounded = boundUsedResult(value);
      if (jsonBytes(value) <= USED_RESULT_MAX_BYTES) {
        expect(bounded).toEqual({ result: value });
        return;
      }
      expect(bounded.truncated).toBe(true);
      expect(bounded.result_bytes).toBe(jsonBytes(value));
      expect(jsonBytes(bounded.result)).toBeLessThanOrEqual(USED_RESULT_MAX_BYTES);
    }));

  it("keeps a bounded process result's exit code and the start of its stderr", () =>
    hegel.test((tc) => {
      const exitCode = tc.draw(gs.integers({ minValue: 1, maxValue: 255 }));
      const stderr = tc.draw(gs.text({ alphabet: "abc\n", minSize: 1, maxSize: 200 }));
      const bounded = boundUsedResult({ stdout: "x".repeat(10_000), exitCode, stderr, files: ["a".repeat(5000)] });
      expect(bounded).toEqual({ result: { stdout: "x".repeat(1024), exitCode, stderr }, truncated: true, result_bytes: jsonBytes({ stdout: "x".repeat(10_000), exitCode, stderr, files: ["a".repeat(5000)] }) });
    }));
});
