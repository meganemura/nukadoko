import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { IdGenerator, TimeConversion } from "@cucumber/messages";
import { describe, expect, it } from "vitest";
import { parseFeatureSource } from "../src/feature/load-features.js";
import { mapGwtStep, mapScenario as mapAllureScenario } from "../src/report/allure/map-scenario.js";
import { mapScenario as mapMessagesScenario } from "../src/report/messages/map-scenario.js";
import type { StepRecord } from "../src/record/types.js";
import type { ScenarioRecord, ScenarioStepEntry } from "../src/record/scenario-record.js";

const FEATURE_SOURCE = `Feature: Checkout
  Scenario: a customer checks out
    Given step one
    When step two
    And step three
    Then step four
    And step five
`;

const SCENARIO_START_MS = Date.parse("2026-08-01T00:00:00.000Z");

const drawnStep = gs.tuples(
  gs.booleans(),
  gs.integers({ minValue: 0, maxValue: 5000 }),
  gs.integers({ minValue: 0, maxValue: 2000 }),
  gs.integers({ minValue: -10_000, maxValue: 10_000 }),
);

function stepRecordFor(index: number, startMs: number, stopMs: number): StepRecord {
  const stepRecord: StepRecord = {
    schema_version: 3,
    nukadoko: "0.0.0-test",
    step_record_id: `step-${index}`,
    step: `step ${index}`,
    kind: "run",
    args: {},
    result: null,
    status: "passed",
    environment: "default",
    scenario_record_id: "scn-1",
    run_id: "run-1",
    started_at: new Date(startMs).toISOString(),
    finished_at: new Date(stopMs).toISOString(),
    evidence: { dir: `.nukadoko/records/steps/step-${index}`, screenshots: [] },
    observed: { http_reads: 0, http_writes: 0, processes: null },
    mutates: true,
  };
  return stepRecord;
}

describe("Allure and cucumber-messages place the steps of one record the same way", () => {
  it("gives every step the same start and stop in both reports, in step order", () =>
    hegel.test((tc) => {
      const drawn = tc.draw(gs.arrays(drawnStep, { minSize: 1, maxSize: 5 }));
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;

      const stepRecords = new Map<string, StepRecord>();
      const entries: ScenarioStepEntry[] = drawn.map(([hasRecord, offsetMs, durationMs], index) => {
        if (!hasRecord) {
          return { text: pickle.steps[index]!.text, status: "skipped", step_record_id: null };
        }
        const startMs = SCENARIO_START_MS + offsetMs;
        stepRecords.set(`step-${index}`, stepRecordFor(index, startMs, startMs + durationMs));
        return { text: pickle.steps[index]!.text, status: "passed", step_record_id: `step-${index}` };
      });
      const record: ScenarioRecord = {
        nukadoko: "0.0.0-test",
        scenario_record_id: "scn-1",
        run_id: "run-1",
        feature: "features/checkout.feature",
        scenario: "a customer checks out",
        line: 2,
        status: "passed",
        environment: "default",
        started_at: new Date(SCENARIO_START_MS).toISOString(),
        finished_at: new Date(SCENARIO_START_MS + 8000).toISOString(),
        steps: entries,
        hooks: [],
        evidence: { dir: ".nukadoko/records/scenarios/scn-1", screenshots: [] },
      };

      // The provisional anchor the Allure emitter passes while the run is
      // still going must not leak into the finished report.
      const allure = mapAllureScenario({
        record,
        gherkinDocument,
        pickle,
        posixPath: "features/checkout.feature",
        projectName: null,
        steps: entries.map((entry, index) =>
          mapGwtStep({
            index,
            record: entry,
            stepRecord: entry.step_record_id === null ? null : stepRecords.get(entry.step_record_id)!,
            previousStopMs: SCENARIO_START_MS + drawn[index]![3],
            gherkinDocument,
            pickle,
          }),
        ),
      });
      const messages = mapMessagesScenario({
        record,
        stepRecords,
        pickle,
        newId: IdGenerator.incrementing(),
        hookIds: {},
      });

      const allureSpans = allure.steps.map((step) => [step.startMs, step.stopMs]);
      const messagesSpans = messages.steps.map((step) => [
        TimeConversion.timestampToMillisecondsSinceEpoch(step.testStepStarted.timestamp),
        TimeConversion.timestampToMillisecondsSinceEpoch(step.testStepFinished.timestamp),
      ]);
      expect(allureSpans).toEqual(messagesSpans);
      expect(messages.steps.map((step) => step.testStep.pickleStepId)).toEqual(
        pickle.steps.slice(0, entries.length).map((step) => step.id),
      );

      let previousStopMs = SCENARIO_START_MS;
      allureSpans.forEach(([startMs, stopMs], index) => {
        const [hasRecord, offsetMs, durationMs] = drawn[index]!;
        expect([startMs, stopMs]).toEqual(
          hasRecord ? [SCENARIO_START_MS + offsetMs, SCENARIO_START_MS + offsetMs + durationMs] : [previousStopMs, previousStopMs],
        );
        previousStopMs = stopMs!;
      });
    }));
});
