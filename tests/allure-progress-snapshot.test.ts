import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

// Responsibility: the step-granularity liveness mechanism itself (the
// "Allure ライブ更新" design): a progress snapshot appears after
// `beginScenario` and after every `emitStep`, matches the eventual real
// result's own identity (fullName/testCaseId/historyId/non-excluded
// parameters), carries a `start` one millisecond below the real result's
// own, and is gone the moment `endScenario` writes that real result.
// tests/allure-emitter.test.ts and tests/allure-structure.test.ts already
// prove the real result's own shape is unaffected by any of this (a
// progress file never survives past `endScenario`, so their own
// `*-result.json` counts still hold) — this file is the one place that
// reads `*-progress-result.json` directly.

const FEATURE_SOURCE = `Feature: Checkout
  Handles the checkout flow.

  Scenario: a customer checks out
    Given the cart has items
    Then the total is correct

  Scenario Outline: checkout as <role>
    Given a <role> customer

    Examples:
      | role   |
      | guest  |
      | member |
`;

function readProgressFileNames(resultsDir: string): string[] {
  return readdirSync(resultsDir).filter((name) => name.endsWith("-progress-result.json"));
}

function readFinalFileNames(resultsDir: string): string[] {
  return readdirSync(resultsDir).filter(
    (name) => name.endsWith("-result.json") && !name.endsWith("-progress-result.json"),
  );
}

function readJson(resultsDir: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(resultsDir, name), "utf8")) as Record<string, unknown>;
}

/** `readdirSync`'s own order is never write order (fresh uuids sort
 * effectively at random) -- this is the one way to name "the progress file
 * a specific `emitStep` call just wrote": diff the directory listing from
 * immediately before that call against immediately after. */
function newProgressFileSince(resultsDir: string, before: ReadonlySet<string>): string {
  const added = readProgressFileNames(resultsDir).filter((name) => !before.has(name));
  if (added.length !== 1) {
    throw new Error(`expected exactly one new progress file, found ${added.length}: ${added.join(", ")}`);
  }
  return added[0]!;
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

describe("createAllureEmitter: progress snapshots", () => {
  let rootDir: string;
  let resultsDir: string;
  let emitter: AllureEmitter;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-allure-progress-"));
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

  it("adds one progress file after beginScenario, one more after each emitStep, then zero (and one final) after endScenario", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles.find((p) => p.name === "a customer checks out")!;
    const steps: ScenarioStepRecord[] = pickle.steps.map((step) => ({
      text: step.text,
      status: "passed",
      step_record_id: null,
    }));

    emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
    expect(readProgressFileNames(resultsDir)).toHaveLength(1);

    emitter.emitStep(baseStepInput({ record: steps[0]!, stepRecord: null, gherkinDocument, pickle, index: 0 }));
    expect(readProgressFileNames(resultsDir)).toHaveLength(2);

    emitter.emitStep(baseStepInput({ record: steps[1]!, stepRecord: null, gherkinDocument, pickle, index: 1 }));
    expect(readProgressFileNames(resultsDir)).toHaveLength(3);

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

    expect(readProgressFileNames(resultsDir)).toHaveLength(0);
    expect(readFinalFileNames(resultsDir)).toHaveLength(1);
  });

  it("gives a progress snapshot the exact same fullName/testCaseId/historyId/non-excluded parameters as the eventual final result (an Outline row, Examples cell included)", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles.find((p) => p.name === "checkout as guest")!;
    const step: ScenarioStepRecord = { text: pickle.steps[0]!.text, status: "passed", step_record_id: null };

    emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
    const beforeEmitStep = new Set(readProgressFileNames(resultsDir));
    emitter.emitStep(baseStepInput({ record: step, stepRecord: null, gherkinDocument, pickle, index: 0 }));

    // The snapshot the `emitStep` call above just wrote, not
    // `beginScenario`'s own initial one -- but every one of a scenario's
    // own snapshots is supposed to carry identical identity, so either
    // would do.
    const snapshot = readJson(resultsDir, newProgressFileSince(resultsDir, beforeEmitStep)) as {
      fullName: string;
      testCaseId: string;
      historyId: string;
      parameters: { name: string; value: string; excluded?: boolean }[];
    };

    const record: ScenarioRecord = {
      scenario_record_id: "scn-outline-1",
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
      evidence: { dir: ".nukadoko/records/scenarios/scn-outline-1", screenshots: [] },
    };
    emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

    const final = readFinalFileNames(resultsDir).map((name) => readJson(resultsDir, name))[0] as {
      fullName: string;
      testCaseId: string;
      historyId: string;
      parameters: { name: string; value: string; excluded?: boolean }[];
    };

    expect(snapshot.fullName).toBe(final.fullName);
    expect(snapshot.testCaseId).toBe(final.testCaseId);
    expect(snapshot.historyId).toBe(final.historyId);
    expect(snapshot.parameters.some((p) => p.name === "role" && p.value === "guest")).toBe(true);
    expect(snapshot.parameters.filter((p) => p.excluded !== true)).toEqual(
      final.parameters.filter((p) => p.excluded !== true),
    );
  });

  it("freezes every snapshot's own start to one millisecond below the final result's start", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles.find((p) => p.name === "a customer checks out")!;
    const step: ScenarioStepRecord = { text: pickle.steps[0]!.text, status: "passed", step_record_id: null };
    const startedAt = new Date("2026-08-01T09:00:00.000Z");

    emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument, startedAt }));
    const initialSnapshot = readJson(resultsDir, readProgressFileNames(resultsDir)[0]!) as { start: number };
    expect(initialSnapshot.start).toBe(startedAt.getTime() - 1);
    expect(typeof initialSnapshot.start).toBe("number");

    emitter.emitStep(baseStepInput({ record: step, stepRecord: null, gherkinDocument, pickle, index: 0 }));
    const laterSnapshots = readProgressFileNames(resultsDir).map((name) => readJson(resultsDir, name) as { start: number });
    for (const snapshot of laterSnapshots) {
      expect(snapshot.start).toBe(startedAt.getTime() - 1);
    }

    const record: ScenarioRecord = {
      scenario_record_id: "scn-1",
      run_id: "run-1",
      feature: "features/checkout.feature",
      scenario: pickle.name,
      line: pickle.location?.line ?? 0,
      status: "passed",
      environment: "staging",
      session: null,
      started_at: startedAt.toISOString(),
      finished_at: "2026-08-01T09:00:01.000Z",
      steps: [step],
      hooks: [],
      evidence: { dir: ".nukadoko/records/scenarios/scn-1", screenshots: [] },
    };
    emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

    const final = readFinalFileNames(resultsDir).map((name) => readJson(resultsDir, name))[0] as { start: number };
    expect(final.start).toBe(startedAt.getTime());
    expect(initialSnapshot.start).toBe(final.start - 1);
  });

  it("lists every pickle step in the initial snapshot, none of them carrying a status yet", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles.find((p) => p.name === "a customer checks out")!;

    emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));

    const initialSnapshot = readJson(resultsDir, readProgressFileNames(resultsDir)[0]!) as {
      steps: { name: string; status?: string }[];
    };
    expect(initialSnapshot.steps).toHaveLength(pickle.steps.length);
    expect(initialSnapshot.steps.map((s) => s.name)).toEqual([
      "Given the cart has items",
      "Then the total is correct",
    ]);
    for (const step of initialSnapshot.steps) {
      expect(step.status).toBeUndefined();
    }
  });

  it("reflects a completed step's own real status/timing while later steps stay planned", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles.find((p) => p.name === "a customer checks out")!;
    const step: ScenarioStepRecord = { text: pickle.steps[0]!.text, status: "passed", step_record_id: null };

    emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
    const beforeEmitStep = new Set(readProgressFileNames(resultsDir));
    emitter.emitStep(baseStepInput({ record: step, stepRecord: null, gherkinDocument, pickle, index: 0 }));

    const latest = readJson(resultsDir, newProgressFileSince(resultsDir, beforeEmitStep)) as {
      steps: { name: string; status?: string }[];
    };
    expect(latest.steps[0]!.status).toBe("passed");
    expect(latest.steps[1]!.status).toBeUndefined();
    expect(latest.steps[1]!.name).toBe("Then the total is correct");
  });

  it("never lists attachments on a snapshot's own steps, even when the real step record would carry one", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles.find((p) => p.name === "a customer checks out")!;
    const step: ScenarioStepRecord = { text: pickle.steps[0]!.text, status: "passed", step_record_id: "step-1" };

    emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
    const beforeEmitStep = new Set(readProgressFileNames(resultsDir));
    emitter.emitStep(baseStepInput({ record: step, stepRecord: null, gherkinDocument, pickle, index: 0 }));

    const latest = readJson(resultsDir, newProgressFileSince(resultsDir, beforeEmitStep)) as {
      steps: { name: string; attachments?: unknown[] }[];
    };
    for (const s of latest.steps) {
      expect(s.attachments ?? []).toHaveLength(0);
    }
  });

  it("cleans only *-progress-result.json at begin(), leaving an existing *-result.json alone", () => {
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(path.join(resultsDir, "stray-uuid-progress-result.json"), "{}");
    writeFileSync(path.join(resultsDir, "kept-uuid-result.json"), "{}");

    const secondEmitter = createAllureEmitter({
      resultsDir,
      rootDir,
      environment: "staging",
      secrets: [],
      stderr: createCaptureSink(),
    });
    secondEmitter.begin();

    expect(readProgressFileNames(resultsDir)).toHaveLength(0);
    expect(readFinalFileNames(resultsDir)).toContain("kept-uuid-result.json");
  });

  it("never lets a progress snapshot's own uuid into the scope container's own children", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles.find((p) => p.name === "a customer checks out")!;
    const step: ScenarioStepRecord = { text: pickle.steps[0]!.text, status: "passed", step_record_id: null };

    emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
    emitter.emitStep(baseStepInput({ record: step, stepRecord: null, gherkinDocument, pickle, index: 0 }));

    const progressUuids = readProgressFileNames(resultsDir).map((name) => (readJson(resultsDir, name) as { uuid: string }).uuid);
    expect(progressUuids.length).toBeGreaterThan(0);

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
      finished_at: "2026-08-01T00:00:01.000Z",
      steps: [step],
      hooks: [{ type: "before", status: "ok" }],
      evidence: { dir: ".nukadoko/records/scenarios/scn-1", screenshots: [] },
    };
    emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

    const containerNames = readdirSync(resultsDir).filter((name) => name.endsWith("-container.json"));
    const containers = containerNames.map((name) => readJson(resultsDir, name)) as { children: string[] }[];
    for (const container of containers) {
      for (const uuid of progressUuids) {
        expect(container.children).not.toContain(uuid);
      }
    }
  });
});
