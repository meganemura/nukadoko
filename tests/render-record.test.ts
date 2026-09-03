import { describe, expect, it } from "vitest";
import { renderAcceptanceRecord, type AcceptedScenario, type RenderAcceptanceRecordOptions } from "../src/accept/render-record.js";
import type { StepRecord } from "../src/record/types.js";
import type { ScenarioHookRecord, ScenarioRecord, ScenarioStepRecord } from "../src/run/record-types.js";

// Responsibility: unit tests for render-record.ts's `renderHook`/`hookLabel`
// — a non-exhaustive ternary used
// to render every `"after_step"` hook as "After hook", silently dropping
// which step it ran after. These tests cover the runtime fix (all three hook
// types get distinct labels; `after_step`'s own label carries `step_index`)
// through the only exported entry point, `renderAcceptanceRecord` (`hookLabel`
// itself is not exported — same "test the pure transform through its public
// surface" precedent as tests/messages-map-scenario.test.ts). The other half
// of the fix — a `switch` + `never`-typed default that fails `npm run
// typecheck` if `ScenarioHookRecord["type"]` ever grows a fourth value — is a
// compile-time property, not a runtime one; it is checked every time the
// gate's own `npm run typecheck` runs, not by a test here.

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

function baseOptions(hooks: readonly ScenarioHookRecord[]): RenderAcceptanceRecordOptions {
  const record = baseRecord({ hooks });
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
  };
}

/** Every `#### ...` heading line in the rendered record, in order — the
 * markdown surface a human (or a diff) actually reads, rather than the JSON
 * body underneath it. */
function headings(markdown: string): string[] {
  return markdown.split("\n").filter((line) => line.startsWith("#### "));
}

describe("renderAcceptanceRecord: hook labels", () => {
  it("labels a before hook and an after hook distinctly", () => {
    const hooks: ScenarioHookRecord[] = [
      { type: "before", status: "ok" },
      { type: "after", status: "ok" },
    ];
    const markdown = renderAcceptanceRecord(baseOptions(hooks));

    expect(headings(markdown)).toEqual(["#### Before hook", "#### After hook"]);
  });

  it("labels an after_step hook distinctly from a genuine after hook, and includes its step_index", () => {
    const hooks: ScenarioHookRecord[] = [
      { type: "after_step", status: "ok", step_index: 1 },
      { type: "after", status: "ok" },
    ];
    const markdown = renderAcceptanceRecord(baseOptions(hooks));

    const found = headings(markdown);
    expect(found).toEqual(["#### AfterStep hook (step 1)", "#### After hook"]);
    // The bug this task fixes: a non-exhaustive ternary rendered every
    // after_step hook as "After hook" — assert the count directly so a
    // regression back to that ternary (which would collapse both headings
    // into "#### After hook" twice) fails this test.
    expect(found.filter((h) => h === "#### After hook")).toHaveLength(1);
  });

  it("gives two after_step hooks with different step_index two distinguishable headings", () => {
    const hooks: ScenarioHookRecord[] = [
      { type: "after_step", status: "ok", step_index: 0 },
      { type: "after_step", status: "failed", step_index: 2, error: { message: "boom", kind: "step_error" } },
    ];
    const markdown = renderAcceptanceRecord(baseOptions(hooks));

    expect(headings(markdown)).toEqual(["#### AfterStep hook (step 0)", "#### AfterStep hook (step 2)"]);
  });
});

// Responsibility: unit tests for renderDeclaredVsObserved —
// the record's own tail section that compares each
// step's own step record mutates (declared) against step record
// observed.http_writes (measured), without ever changing whether
// renderAcceptanceRecord itself throws or what cli/accept.ts does with its
// result (this module never decides refusal; see render-record.ts's own
// header).

function makeStepRecord(overrides: {
  mutates: boolean | null;
  observed: { http_reads: number; http_writes: number };
  recordId?: string;
}): StepRecord {
  return {
    step_record_id: overrides.recordId ?? "step-1",
    step: "some.step",
    kind: "run",
    args: {},
    environment: "default",
    session: null,
    scenario_record_id: "scn-1",
    run_id: "run-1",
    started_at: "2026-08-01T00:00:00.000Z",
    finished_at: "2026-08-01T00:00:01.000Z",
    evidence: { dir: ".nukadoko/records/steps/step-1", screenshots: [] },
    observed: overrides.observed,
    mutates: overrides.mutates,
    status: "ok",
    result: {},
  };
}

function scenarioStep(text: string, recordId: string): ScenarioStepRecord {
  return { text, status: "passed", step_record_id: recordId };
}

function scenarioWithSteps(
  steps: readonly ScenarioStepRecord[],
  stepRecords: ReadonlyMap<string, StepRecord | null>,
  overrides: Partial<ScenarioRecord> = {},
): AcceptedScenario {
  return { record: baseRecord({ steps, ...overrides }), stepRecords };
}

function optionsFor(scenarios: readonly AcceptedScenario[]): RenderAcceptanceRecordOptions {
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
    scenarios,
  };
}

/** The "## Declared vs observed" section and everything after it — the only
 * part of the record these tests care about. */
function declaredVsObservedSection(markdown: string): string {
  const idx = markdown.indexOf("## Declared vs observed");
  if (idx === -1) throw new Error("no '## Declared vs observed' section found in rendered record");
  return markdown.slice(idx);
}

describe("renderAcceptanceRecord: Declared vs observed", () => {
  it("lists a step that declared mutates: false and was measured making writes", () => {
    const stepRecords = new Map<string, StepRecord | null>([
      ["r-1", makeStepRecord({ recordId: "r-1", mutates: false, observed: { http_reads: 0, http_writes: 2 } })],
    ]);
    const scenario = scenarioWithSteps([scenarioStep("the todo list is fetched", "r-1")], stepRecords, {
      scenario: "a visitor browses",
    });

    const rendered = renderAcceptanceRecord(optionsFor([scenario]));
    const section = declaredVsObservedSection(rendered);

    expect(section).toContain(
      '- "the todo list is fetched" (scenario "a visitor browses"): declared mutates: false, observed 2 writes',
    );
    // The count is also up front, in Condition, ahead of every scenario
    // section: the tail is where the list lives, not the only place the
    // fact appears.
    expect(rendered.indexOf("- declared vs observed: 1 step declared `mutates: false` and was measured making writes; listed at the end")).toBeGreaterThan(-1);
    expect(rendered.indexOf("- declared vs observed:")).toBeLessThan(rendered.indexOf("## The scenario as it ran"));
  });

  it("omits a step that declared mutates: false but was measured making zero writes", () => {
    const stepRecords = new Map<string, StepRecord | null>([
      ["r-1", makeStepRecord({ recordId: "r-1", mutates: false, observed: { http_reads: 3, http_writes: 0 } })],
    ]);
    const scenario = scenarioWithSteps([scenarioStep("the todo list is fetched", "r-1")], stepRecords);

    const section = declaredVsObservedSection(renderAcceptanceRecord(optionsFor([scenario])));

    expect(section).not.toContain("the todo list is fetched");
    expect(section).toContain("No step declared `mutates: false` and was measured making a write.");
  });

  it("omits a step that declared mutates: true even though it was measured making writes", () => {
    const stepRecords = new Map<string, StepRecord | null>([
      ["r-1", makeStepRecord({ recordId: "r-1", mutates: true, observed: { http_reads: 0, http_writes: 3 } })],
    ]);
    const scenario = scenarioWithSteps([scenarioStep("the todo is created", "r-1")], stepRecords);

    const section = declaredVsObservedSection(renderAcceptanceRecord(optionsFor([scenario])));

    expect(section).not.toContain("the todo is created");
    expect(section).toContain("No step declared `mutates: false` and was measured making a write.");
  });

  it("still writes the section, with an explicit zero-mismatch sentence, when nothing disagrees", () => {
    const stepRecords = new Map<string, StepRecord | null>([
      ["r-1", makeStepRecord({ recordId: "r-1", mutates: true, observed: { http_reads: 0, http_writes: 1 } })],
    ]);
    const scenario = scenarioWithSteps([scenarioStep("the todo is created", "r-1")], stepRecords);

    const markdown = renderAcceptanceRecord(optionsFor([scenario]));

    // The section header itself must exist — its absence would be
    // indistinguishable from "never compared at all", the exact ambiguity
    // this section exists to remove.
    expect(markdown).toContain("## Declared vs observed");
    expect(declaredVsObservedSection(markdown)).toContain(
      "No step declared `mutates: false` and was measured making a write.",
    );
  });

  it("excludes a compat step (mutates: null) from the mismatch list and counts it separately", () => {
    const stepRecords = new Map<string, StepRecord | null>([
      ["r-1", makeStepRecord({ recordId: "r-1", mutates: null, observed: { http_reads: 0, http_writes: 5 } })],
    ]);
    const scenario = scenarioWithSteps([scenarioStep("a compat step runs", "r-1")], stepRecords);

    const section = declaredVsObservedSection(renderAcceptanceRecord(optionsFor([scenario])));

    // Not a mismatch — a compat step has no `mutates` declaration to compare
    // against `observed` at all, which is a different fact from "compared
    // and agreed" (design doc, unresolved point 2).
    expect(section).not.toContain("a compat step runs");
    expect(section).toContain("No step declared `mutates: false` and was measured making a write.");
    expect(section).toContain("1 compat step has no `mutates` declaration to compare.");
  });

  it("pluralizes the compat-step count and rolls up mismatches from every scenario into one section", () => {
    const stepRecords = new Map<string, StepRecord | null>([
      ["r-1", makeStepRecord({ recordId: "r-1", mutates: false, observed: { http_reads: 0, http_writes: 1 } })],
      ["r-2", makeStepRecord({ recordId: "r-2", mutates: false, observed: { http_reads: 0, http_writes: 4 } })],
      ["r-3", makeStepRecord({ recordId: "r-3", mutates: null, observed: { http_reads: 0, http_writes: 0 } })],
      ["r-4", makeStepRecord({ recordId: "r-4", mutates: null, observed: { http_reads: 0, http_writes: 0 } })],
    ]);
    const scenarioA = scenarioWithSteps(
      [scenarioStep("step one", "r-1"), scenarioStep("step three", "r-3")],
      stepRecords,
      {
        scenario_record_id: "scn-a",
        scenario: "scenario A",
      },
    );
    const scenarioB = scenarioWithSteps(
      [scenarioStep("step two", "r-2"), scenarioStep("step four", "r-4")],
      stepRecords,
      {
        scenario_record_id: "scn-b",
        scenario: "scenario B",
      },
    );

    const markdown = renderAcceptanceRecord(optionsFor([scenarioA, scenarioB]));

    // One roll-up section, not one per scenario.
    expect(markdown.split("## Declared vs observed")).toHaveLength(2);
    const section = declaredVsObservedSection(markdown);
    expect(section).toContain('- "step one" (scenario "scenario A"): declared mutates: false, observed 1 write');
    expect(section).toContain('- "step two" (scenario "scenario B"): declared mutates: false, observed 4 writes');
    expect(section).toContain("2 compat steps have no `mutates` declaration to compare.");
  });
});
