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

// Responsibility: tests/allure-emitter.test.ts already drives the full
// beginScenario/emitStep/endScenario cycle and one failure-isolation case
// inside emitStep. This file covers what it leaves untouched: emitStep/
// endScenario called with no scope open at all (never throws, silently
// does nothing), endScenario's own failure isolation (the same "genuine
// internal failure must never escape" contract emitStep already has,
// exercised here for endScenario's own try block instead), and a custom
// ALLURE_LABEL_* environment label actually reaching a test's own labels,
// redacted the same as everything else options.secrets covers.

const FEATURE_SOURCE = `Feature: Checkout
  Handles the checkout flow.

  Scenario: a customer checks out
    Given the cart has items
    Then the total is correct
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

function baseScenarioRecord(overrides: Partial<ScenarioRecord> & Pick<ScenarioRecord, "scenario_record_id" | "steps">): ScenarioRecord {
  return {
    run_id: "run-1",
    feature: "features/checkout.feature",
    scenario: "a customer checks out",
    line: 3,
    status: "passed",
    environment: "staging",
    session: null,
    started_at: "2026-08-01T00:00:00.000Z",
    finished_at: "2026-08-01T00:00:00.500Z",
    hooks: [],
    evidence: { dir: `.nukadoko/records/scenarios/${overrides.scenario_record_id}`, screenshots: [] },
    ...overrides,
  };
}

describe("createAllureEmitter: scope lifecycle", () => {
  let rootDir: string;
  let resultsDir: string;
  let sink: { write(chunk: string): boolean; text(): string };
  let emitter: AllureEmitter;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-allure-scope-"));
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: "acme-checkout" }));
    resultsDir = path.join(rootDir, ".nukadoko", "export", "allure-results");
    sink = createCaptureSink();
    emitter = createAllureEmitter({
      resultsDir,
      rootDir,
      environment: "staging",
      secrets: [],
      stderr: sink,
    });
    emitter.begin();
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("emitStep is a silent no-op when no scope is open (beginScenario never ran)", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles[0]!;
    const record: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: null };

    const before = new Set(readdirSync(resultsDir));
    expect(() =>
      emitter.emitStep(baseStepInput({ record, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-no-scope" })),
    ).not.toThrow();
    expect(new Set(readdirSync(resultsDir))).toEqual(before);
  });

  it("endScenario is a silent no-op when no scope is open (beginScenario never ran)", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles[0]!;
    const record = baseScenarioRecord({
      scenario_record_id: "scn-no-scope-end",
      steps: [{ text: "the cart has items", status: "passed", step_record_id: null }],
    });

    const before = new Set(readdirSync(resultsDir));
    expect(() =>
      emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" }),
    ).not.toThrow();
    expect(new Set(readdirSync(resultsDir))).toEqual(before);
  });

  it("endScenario is a silent no-op the second time in a row (its own beginScenario/endScenario pairing, not just emitStep's)", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: null };
    const record = baseScenarioRecord({ scenario_record_id: "scn-double-end", steps: [step] });

    emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
    emitter.emitStep(baseStepInput({ record: step, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-double-end" }));
    emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });
    const afterFirstEnd = new Set(readdirSync(resultsDir));

    expect(() =>
      emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" }),
    ).not.toThrow();
    expect(new Set(readdirSync(resultsDir))).toEqual(afterFirstEnd);
  });

  it("catches a genuine internal failure in endScenario (a scenario evidence file that isn't actually there), warns once to stderr, and leaves an earlier scenario's own already-written output intact", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles[0]!;

    // A healthy scenario, run to completion first, to prove its own output
    // survives a later scenario's own endScenario failure -- with one
    // result per scenario now (not one per step), "earlier scenario" is the
    // unit whose isolation this test can still demonstrate; there is no
    // longer a second step's own file inside the *same* scenario to isolate
    // from (this file's own header: a bad attachment now costs the whole
    // scenario it belongs to).
    const healthyStep: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: null };
    emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
    emitter.emitStep(baseStepInput({ record: healthyStep, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-healthy" }));
    emitter.endScenario({
      record: baseScenarioRecord({ scenario_record_id: "scn-healthy", steps: [healthyStep] }),
      gherkinDocument,
      pickle,
      relativeFeaturePath: "features/checkout.feature",
    });
    const healthyFiles = new Set(readdirSync(resultsDir));
    expect(healthyFiles.size).toBeGreaterThan(0);

    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: null };
    const record = baseScenarioRecord({
      scenario_record_id: "scn-evidence-broken",
      steps: [step],
      // Names a trace file this test deliberately never writes to disk: the
      // scenario-wide evidence attachment (map-scenario.ts's own
      // `mapScenario`) builds it from this alone, with no existsSync check
      // of its own, so the failure surfaces where writeAttachment's
      // underlying copy actually runs, inside endScenario's own try block.
      evidence: { dir: ".nukadoko/records/scenarios/scn-evidence-broken", trace: "missing-trace.zip", screenshots: [] },
    });

    emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
    emitter.emitStep(baseStepInput({ record: step, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-evidence-broken" }));

    expect(() =>
      emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" }),
    ).not.toThrow();

    expect(sink.text()).toContain("warning:");
    expect(sink.text()).toContain("scn-evidence-broken");

    const afterFiles = new Set(readdirSync(resultsDir));
    for (const name of healthyFiles) {
      expect(afterFiles.has(name)).toBe(true);
    }
  });
});

describe("createAllureEmitter: ALLURE_LABEL_* environment labels", () => {
  it("adds a redacted custom label from process.env, the same way every other label field is redacted", () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-allure-env-label-"));
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: "acme-checkout" }));
    const resultsDir = path.join(rootDir, ".nukadoko", "export", "allure-results");
    const secretValue = "s3cr3t-token-value";

    process.env.ALLURE_LABEL_TOKEN_SECRET = secretValue;
    try {
      const emitter = createAllureEmitter({
        resultsDir,
        rootDir,
        environment: "staging",
        secrets: [{ name: "TOKEN", value: secretValue }],
        stderr: createCaptureSink(),
      });
      emitter.begin();

      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: null };
      const record = baseScenarioRecord({ scenario_record_id: "scn-env-label", steps: [step] });

      emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
      emitter.emitStep(baseStepInput({ record: step, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-env-label" }));
      emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

      const results = readResultFiles(resultsDir) as { name?: string; labels?: { name: string; value: string }[] }[];
      const test = results.find((r) => r.name === "a customer checks out")!;
      expect(test.labels).toContainEqual({ name: "TOKEN_SECRET", value: "{{secret.TOKEN}}" });
      expect(JSON.stringify(test.labels)).not.toContain(secretValue);
    } finally {
      delete process.env.ALLURE_LABEL_TOKEN_SECRET;
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
