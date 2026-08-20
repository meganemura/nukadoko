import { describe, expect, it } from "vitest";
import {
  MissingStepRecordError,
  renderAcceptanceRecord,
  type AcceptedScenario,
  type RenderAcceptanceRecordOptions,
} from "../src/accept/render-record.js";
import type { ScenarioRecord, ScenarioStepRecord } from "../src/run/record-types.js";

// Responsibility: unit tests for render-record.ts's own frontmatter details
// tests/render-record.test.ts and the E2E accept*.test.ts files never
// exercise: `yamlScalar`'s own quoting rules (every scenario name a real
// fixture project uses is already plain-scalar-safe, so none of its
// conditions fire in those suites), a record whose accepted run measured a
// `target_version`, and the one `MissingStepRecordError` shape that names a
// step with no step record id at all rather than one that failed to read
// back from disk (accept-cli-refusals.test.ts's own case).

function baseRecord(overrides: Partial<ScenarioRecord> = {}): ScenarioRecord {
  return {
    scenario_record_id: "scn-1",
    run_id: "run-1",
    feature: "features/checkout.feature",
    scenario: "a customer checks out",
    line: 2,
    status: "passed",
    environment: "default",
    session: null,
    started_at: "2026-08-01T00:00:00.000Z",
    finished_at: "2026-08-01T00:00:03.000Z",
    steps: [],
    hooks: [],
    evidence: { dir: ".nukadoko/records/scenarios/scn-1", screenshots: [] },
    ...overrides,
  };
}

function baseOptions(overrides: Partial<RenderAcceptanceRecordOptions> = {}): RenderAcceptanceRecordOptions {
  const record = baseRecord();
  return {
    featurePath: "features/checkout.feature",
    featureSource: "Feature: Checkout\n  Scenario: a customer checks out\n",
    featureName: "Checkout",
    commit: "a".repeat(40),
    runId: "run-1",
    ranAt: "2026-08-01T00:00:00.000Z",
    acceptedAt: "2026-08-01T00:00:05.000Z",
    environment: "default",
    targetVersion: undefined,
    browser: undefined,
    scenarios: [{ record, stepRecords: new Map() }],
    ...overrides,
  };
}

/** The one `- name: <scalar>` line frontmatter writes per scenario — the
 * surface every quoting test below actually reads its answer off. */
function scenarioNameLine(markdown: string): string {
  const line = markdown.split("\n").find((candidate) => candidate.trimStart().startsWith("- name:"));
  if (line === undefined) throw new Error("no '- name:' frontmatter line found");
  return line.trim();
}

function optionsWithScenarioName(name: string): RenderAcceptanceRecordOptions {
  return baseOptions({ scenarios: [{ record: baseRecord({ scenario: name }), stepRecords: new Map() }] });
}

describe("renderAcceptanceRecord: yaml quoting of a scenario name", () => {
  it("quotes an empty name", () => {
    const line = scenarioNameLine(renderAcceptanceRecord(optionsWithScenarioName("")));
    expect(line).toBe(`- name: ${JSON.stringify("")}`);
  });

  it("quotes a name with leading whitespace", () => {
    const name = " leading space";
    const line = scenarioNameLine(renderAcceptanceRecord(optionsWithScenarioName(name)));
    expect(line).toBe(`- name: ${JSON.stringify(name)}`);
  });

  it("quotes a name containing a literal newline", () => {
    const name = "two\nlines";
    const line = scenarioNameLine(renderAcceptanceRecord(optionsWithScenarioName(name)));
    expect(line).toBe(`- name: ${JSON.stringify(name)}`);
  });

  it("quotes a name starting with a yaml indicator character", () => {
    const name = "-dash-led name";
    const line = scenarioNameLine(renderAcceptanceRecord(optionsWithScenarioName(name)));
    expect(line).toBe(`- name: ${JSON.stringify(name)}`);
  });

  it("quotes a name containing ': ' mid-string", () => {
    const name = "a note: important";
    const line = scenarioNameLine(renderAcceptanceRecord(optionsWithScenarioName(name)));
    expect(line).toBe(`- name: ${JSON.stringify(name)}`);
  });

  it("quotes a name containing ' #'", () => {
    const name = "ticket #42";
    const line = scenarioNameLine(renderAcceptanceRecord(optionsWithScenarioName(name)));
    expect(line).toBe(`- name: ${JSON.stringify(name)}`);
  });

  it("leaves an ordinary name unquoted", () => {
    const name = "a customer checks out";
    const line = scenarioNameLine(renderAcceptanceRecord(optionsWithScenarioName(name)));
    expect(line).toBe(`- name: ${name}`);
  });
});

describe("renderAcceptanceRecord: target_version frontmatter", () => {
  it("writes a target_version line when the accepted run recorded one", () => {
    const markdown = renderAcceptanceRecord(baseOptions({ targetVersion: "2.4.0" }));
    expect(markdown).toContain('target_version: "2.4.0"');
  });
});

describe("renderAcceptanceRecord: MissingStepRecordError", () => {
  function scenarioStep(text: string, recordId: string | null): ScenarioStepRecord {
    return { text, status: "passed", step_record_id: recordId };
  }

  function scenarioWithSteps(steps: readonly ScenarioStepRecord[]): AcceptedScenario {
    return { record: baseRecord({ steps }), stepRecords: new Map() };
  }

  it("names the step and says so, when a passed scenario's own step has no step record id at all", () => {
    const scenario = scenarioWithSteps([scenarioStep("a step with nothing to point at", null)]);

    expect(() => renderAcceptanceRecord(baseOptions({ scenarios: [scenario] }))).toThrow(MissingStepRecordError);
    try {
      renderAcceptanceRecord(baseOptions({ scenarios: [scenario] }));
      throw new Error("expected renderAcceptanceRecord to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingStepRecordError);
      expect((error as Error).message).toContain("a step with nothing to point at");
      expect((error as Error).message).toContain("no step record id even though the scenario is recorded as passed");
    }
  });
});
