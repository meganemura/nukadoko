import { describe, expect, it } from "vitest";
import { renderAcceptanceRecord, type RenderAcceptanceRecordOptions } from "../src/accept/render-record.js";
import type { ScenarioHookRecord, ScenarioRecord } from "../src/run/record-types.js";

// Responsibility: unit tests for render-record.ts's `renderHook`/`hookLabel`
// (t7-afterstep-consumers task spec, item 2) — a non-exhaustive ternary used
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
    scenario_id: "scn-1",
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
    evidence: { dir: ".nukadoko/scenarios/scn-1", screenshots: [] },
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
    scenarios: [{ record, receipts: new Map() }],
  };
}

/** Every `#### ...` heading line in the rendered record, in order — the
 * markdown surface a human (or a diff) actually reads, rather than the JSON
 * body underneath it. */
function headings(markdown: string): string[] {
  return markdown.split("\n").filter((line) => line.startsWith("#### "));
}

describe("renderAcceptanceRecord: hook labels (t7-afterstep-consumers task spec, test item 2)", () => {
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
