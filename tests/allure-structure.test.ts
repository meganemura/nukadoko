import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFeatureSource } from "../src/feature/load-features.js";
import {
  createAllureEmitter,
  type AllureEmitter,
  type BeginScenarioInput,
  type EmitStepInput,
} from "../src/report/allure/emitter.js";
import type { ScenarioRecord, ScenarioStepRecord } from "../src/run/record-types.js";
import { createCaptureSink } from "./helpers/fixtures.js";

// Responsibility: pins the official allure-cucumberjs structure this Allure
// emitter is being restructured onto -- one pickle, one Allure test result,
// its own Given/When/Then/And steps nested under it as `steps[]`, no
// separate per-step test and no separate scenario-wide test. Written before
// that restructuring landed, against the emitter's own stable public surface
// (`beginScenario`/`emitStep`/`endScenario`), so this file's own assertions
// stay meaningful (and, before the restructuring, fail) without depending on
// the internal shape of map-scenario.ts.

const FEATURE_SOURCE = `Feature: Checkout
  Handles the checkout flow.

  Scenario: a customer checks out
    Given the cart has items
    And another item is added
    When the customer pays
    Then the order is confirmed
`;

function readResultFiles(resultsDir: string): Record<string, unknown>[] {
  return readdirSync(resultsDir)
    .filter((name) => name.endsWith("-result.json"))
    .map((name) => JSON.parse(readFileSync(path.join(resultsDir, name), "utf8")));
}

function baseBeginScenarioInput(
  overrides: Partial<BeginScenarioInput> & Pick<BeginScenarioInput, "pickle" | "gherkinDocument">,
): BeginScenarioInput {
  return {
    relativeFeaturePath: "features/checkout.feature",
    startedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function baseStepInput(overrides: Partial<EmitStepInput> & Pick<EmitStepInput, "record" | "stepRecord">): EmitStepInput {
  return {
    runId: "run-1",
    scenarioId: "scn-1",
    environment: "staging",
    session: null,
    index: 0,
    finishedAt: new Date("2026-08-01T00:00:01.000Z"),
    gherkinDocument: overrides.gherkinDocument!,
    pickle: overrides.pickle!,
    relativeFeaturePath: "features/checkout.feature",
    ...overrides,
  };
}

describe("Allure structure: one pickle, one result, GWT steps nested inside it", () => {
  let rootDir: string;
  let resultsDir: string;
  let emitter: AllureEmitter;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-allure-structure-"));
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: "acme-checkout" }));
    resultsDir = path.join(rootDir, ".nukadoko", "export", "allure-results");
    emitter = createAllureEmitter({
      resultsDir,
      rootDir,
      environment: "staging",
      secrets: [],
      stderr: createCaptureSink(),
    });
    emitter.begin();
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("writes exactly one result.json for a 4-step scenario, never one per step plus one for the scenario", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles[0]!;
    const steps: ScenarioStepRecord[] = pickle.steps.map((step) => ({
      text: step.text,
      status: "passed",
      step_record_id: null,
    }));

    emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
    steps.forEach((step, index) => {
      emitter.emitStep(baseStepInput({ record: step, stepRecord: null, gherkinDocument, pickle, index }));
    });
    const record: ScenarioRecord = {
      scenario_record_id: "scn-1",
      run_id: "run-1",
      feature: "features/checkout.feature",
      scenario: pickle.name,
      line: pickle.location?.line ?? 0,
      status: "passed",
      environment: "staging",
      session: null,
      started_at: "2026-08-01T00:00:00.000Z",
      finished_at: "2026-08-01T00:00:02.000Z",
      steps,
      hooks: [],
      evidence: { dir: ".nukadoko/records/scenarios/scn-1", screenshots: [] },
    };
    emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

    const results = readResultFiles(resultsDir);
    expect(results).toHaveLength(1);
    expect((results[0] as { name?: string }).name).toBe("a customer checks out");
  });

  it("nests every GWT step under that one result's own steps[], keyword included and And left un-normalized", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles[0]!;
    const steps: ScenarioStepRecord[] = pickle.steps.map((step) => ({
      text: step.text,
      status: "passed",
      step_record_id: null,
    }));

    emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
    steps.forEach((step, index) => {
      emitter.emitStep(baseStepInput({ record: step, stepRecord: null, gherkinDocument, pickle, index }));
    });
    const record: ScenarioRecord = {
      scenario_record_id: "scn-2",
      run_id: "run-1",
      feature: "features/checkout.feature",
      scenario: pickle.name,
      line: pickle.location?.line ?? 0,
      status: "passed",
      environment: "staging",
      session: null,
      started_at: "2026-08-01T00:00:00.000Z",
      finished_at: "2026-08-01T00:00:02.000Z",
      steps,
      hooks: [],
      evidence: { dir: ".nukadoko/records/scenarios/scn-2", screenshots: [] },
    };
    emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

    const results = readResultFiles(resultsDir);
    const result = results[0] as { steps?: { name: string }[] };
    expect(result.steps?.map((s) => s.name)).toEqual([
      "Given the cart has items",
      "And another item is added",
      "When the customer pays",
      "Then the order is confirmed",
    ]);
  });

  it("carries a feature label, and never a parentSuite/suite label", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: pickle.steps[0]!.text, status: "passed", step_record_id: null };

    emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
    emitter.emitStep(baseStepInput({ record: step, stepRecord: null, gherkinDocument, pickle, index: 0 }));
    const record: ScenarioRecord = {
      scenario_record_id: "scn-3",
      run_id: "run-1",
      feature: "features/checkout.feature",
      scenario: pickle.name,
      line: pickle.location?.line ?? 0,
      status: "passed",
      environment: "staging",
      session: null,
      started_at: "2026-08-01T00:00:00.000Z",
      finished_at: "2026-08-01T00:00:01.000Z",
      steps: [step],
      hooks: [],
      evidence: { dir: ".nukadoko/records/scenarios/scn-3", screenshots: [] },
    };
    emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

    const results = readResultFiles(resultsDir);
    const result = results[0] as { labels?: { name: string; value: string }[] };
    expect(result.labels).toContainEqual({ name: "feature", value: "Checkout" });
    expect(result.labels?.some((l) => l.name === "parentSuite")).toBe(false);
    expect(result.labels?.some((l) => l.name === "suite")).toBe(false);
  });
});
