import { describe, expect, it } from "vitest";
import { renderAcceptanceRecord, type AcceptedScenario, type RenderAcceptanceRecordOptions } from "../src/accept/render-record.js";
import type { StepRecord } from "../src/record/types.js";
import type { ScenarioHookRecord, ScenarioRecord, ScenarioStepRecord } from "../src/run/record-types.js";

// Responsibility: pins down two things an acceptance record's body must do
// that the rest of the render-record.ts test suite doesn't check. First, an
// allowlist rather than a denylist: a step or hook record field this module
// has never heard of must still be dropped, not passed through by accident,
// and the record must say so in one line rather than staying silent about
// it. Second, a per-scenario summary table (step/status/ms/mutates/
// reads/writes) that lets a reviewer see what ran without opening any of the
// per-step JSON blocks below it.

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

function baseOptions(scenarios: readonly AcceptedScenario[]): RenderAcceptanceRecordOptions {
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

/** Builds a `StepRecord`-shaped object with every field this suite needs to
 * hand it, including fields the real `StepRecord` union doesn't declare
 * (an unknown key, for the allowlist-default test) — cast at the boundary
 * since what matters here is what render-record.ts does with arbitrary
 * object keys, not whether the fixture itself type-checks as a step
 * record. */
function makeStepRecord(extra: Record<string, unknown> = {}): StepRecord {
  const base: Record<string, unknown> = {
    step_record_id: "step-1",
    step: "some.step",
    kind: "run",
    args: { name: "Ada" },
    environment: "default",
    session: null,
    scenario_record_id: "scn-1",
    run_id: "run-1",
    started_at: "2026-08-01T00:00:00.000Z",
    finished_at: "2026-08-01T00:00:01.000Z",
    evidence: { dir: ".nukadoko/records/steps/step-1", screenshots: [] },
    observed: { http_reads: 0, http_writes: 0 },
    mutates: true,
    status: "ok",
    result: {},
  };
  return { ...base, ...extra } as unknown as StepRecord;
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

function scenarioWithHooks(hooks: readonly ScenarioHookRecord[]): AcceptedScenario {
  return { record: baseRecord({ hooks }), stepRecords: new Map() };
}

/** The one-line disclosure under "## What the tool measured" naming every
 * key this record actually stripped — thrown if the heading itself is
 * missing, since every rendered record has one. */
function strippedKeysLine(markdown: string): string {
  const idx = markdown.indexOf("## What the tool measured");
  if (idx === -1) throw new Error("no '## What the tool measured' heading found");
  const after = markdown.slice(idx);
  const match = /Evidence fields are stripped from every record below: ([^\n]*)/.exec(after);
  if (!match) throw new Error("no stripped-keys disclosure line found under '## What the tool measured'");
  return match[1]!;
}

/** The markdown slice for one scenario's own section: from its `### `
 * heading up to the next `### ` heading or the `## Declared vs observed`
 * tail, whichever comes first. */
function scenarioBlock(markdown: string, heading: string): string {
  const idx = markdown.indexOf(heading);
  if (idx === -1) throw new Error(`no heading "${heading}" found`);
  const searchFrom = idx + heading.length;
  const nextHeadingIdx = markdown.indexOf("\n### ", searchFrom);
  const tailIdx = markdown.indexOf("\n## Declared vs observed", searchFrom);
  const candidates = [nextHeadingIdx, tailIdx].filter((n) => n !== -1);
  const end = candidates.length === 0 ? markdown.length : Math.min(...candidates);
  return markdown.slice(idx, end);
}

/** Every `| ... |` table row in a scenario block, header and separator rows
 * dropped — the raw line strings, not split into cells (a step name with an
 * escaped `\|` inside it would otherwise be mis-split the same way a naive
 * markdown table splitter would mis-split it). */
function tableDataRows(block: string): string[] {
  const rows = block.split("\n").filter((line) => line.trim().startsWith("|"));
  return rows.slice(2);
}

describe("renderAcceptanceRecord: allowlist, not denylist", () => {
  it("never lets actions/page_events/sections/polls/declared/http_omitted/truncated/evidence reach the output", () => {
    const stepRecord = makeStepRecord({
      actions: [{ method: "goto", url: "https://example.test", outcome: "passed", at: "2026-08-01T00:00:00.100Z", ms: 5 }],
      page_events: { console_errors: [{ text: "boom", at: "2026-08-01T00:00:00.200Z" }] },
      sections: [{ label: "setup", at: "2026-08-01T00:00:00.050Z" }],
      polls: [{ at: "2026-08-01T00:00:00.300Z", attempts: 1, waited_ms: 0, outcome: "resolved" }],
      declared: { attachments: [{ name: "note", type: "text/plain", at: "2026-08-01T00:00:00.400Z" }] },
      http_omitted: { image: 3 },
      truncated: { actions: 150 },
    });
    const stepRecords = new Map<string, StepRecord | null>([["r-1", stepRecord]]);
    const scenario = scenarioWithSteps([scenarioStep("a step with everything attached", "r-1")], stepRecords);

    const markdown = renderAcceptanceRecord(baseOptions([scenario]));

    for (const key of [
      "actions",
      "page_events",
      "sections",
      "polls",
      "declared",
      "http_omitted",
      "truncated",
      "evidence",
    ]) {
      expect(markdown).not.toContain(`"${key}"`);
    }
  });

  it("still carries args/result/observed/mutates/step_record_id — the allowlist must not over-strip", () => {
    const stepRecord = makeStepRecord();
    const stepRecords = new Map<string, StepRecord | null>([["r-1", stepRecord]]);
    const scenario = scenarioWithSteps([scenarioStep("an ordinary step", "r-1")], stepRecords);

    const markdown = renderAcceptanceRecord(baseOptions([scenario]));

    expect(markdown).toContain('"args"');
    expect(markdown).toContain('"result"');
    expect(markdown).toContain('"observed"');
    expect(markdown).toContain('"mutates"');
    expect(markdown).toContain('"step_record_id"');
  });

  it("drops a key the allowlist has never heard of, and names it in the disclosure line", () => {
    const stepRecord = makeStepRecord({ mystery_field: "surprise" });
    const stepRecords = new Map<string, StepRecord | null>([["r-1", stepRecord]]);
    const scenario = scenarioWithSteps([scenarioStep("a step from a newer build", "r-1")], stepRecords);

    const markdown = renderAcceptanceRecord(baseOptions([scenario]));

    expect(markdown).not.toContain('"mystery_field"');
    expect(strippedKeysLine(markdown)).toMatch(/\bmystery_field\b/);
  });

  it("names only the keys actually present on this record, not every key the allowlist could ever drop", () => {
    // This step record carries `evidence` (required on every step record)
    // and nothing else the allowlist drops — no actions, no page_events, no
    // sections, no polls, no declared, no http_omitted, no truncated.
    const stepRecord = makeStepRecord();
    const stepRecords = new Map<string, StepRecord | null>([["r-1", stepRecord]]);
    const scenario = scenarioWithSteps([scenarioStep("a plain step", "r-1")], stepRecords);

    const line = strippedKeysLine(renderAcceptanceRecord(baseOptions([scenario])));

    expect(line).toMatch(/\bevidence\b/);
    for (const key of ["page_events", "actions", "sections", "polls", "declared", "http_omitted", "truncated"]) {
      expect(line).not.toMatch(new RegExp(`\\b${key}\\b`));
    }
  });

  it("strips a hook's own actions the same way, and folds the name into the same disclosure line", () => {
    const hook: ScenarioHookRecord = {
      type: "after",
      status: "ok",
      actions: [{ method: "goto", url: "https://example.test", outcome: "passed", at: "2026-08-01T00:00:00.100Z", ms: 5 }],
      trace: "after-hook-0.trace.zip",
    };
    const markdown = renderAcceptanceRecord(baseOptions([scenarioWithHooks([hook])]));

    expect(markdown).not.toContain('"actions"');
    expect(markdown).not.toContain('"trace"');
    expect(strippedKeysLine(markdown)).toMatch(/\bactions\b/);
    expect(strippedKeysLine(markdown)).toMatch(/\btrace\b/);
  });
});

describe("renderAcceptanceRecord: per-scenario summary table", () => {
  it("lists one row per step, with ms/mutates/reads/writes matching the step record, and compat for mutates: null", () => {
    const stepRecords = new Map<string, StepRecord | null>([
      [
        "r-1",
        makeStepRecord({
          started_at: "2026-08-01T00:00:00.000Z",
          finished_at: "2026-08-01T00:00:01.234Z",
          mutates: true,
          observed: { http_reads: 2, http_writes: 0 },
        }),
      ],
      [
        "r-2",
        makeStepRecord({
          started_at: "2026-08-01T00:00:02.000Z",
          finished_at: "2026-08-01T00:00:02.500Z",
          mutates: false,
          observed: { http_reads: 0, http_writes: 3 },
        }),
      ],
      [
        "r-3",
        makeStepRecord({
          started_at: "2026-08-01T00:00:03.000Z",
          finished_at: "2026-08-01T00:00:03.100Z",
          mutates: null,
          observed: { http_reads: 1, http_writes: 1 },
        }),
      ],
    ]);
    const scenario = scenarioWithSteps(
      [scenarioStep("step A", "r-1"), scenarioStep("step B", "r-2"), scenarioStep("step C", "r-3")],
      stepRecords,
    );

    const markdown = renderAcceptanceRecord(baseOptions([scenario]));
    const block = scenarioBlock(markdown, "### a customer checks out (line 2)");

    expect(tableDataRows(block)).toHaveLength(3);
    expect(block).toContain("| step A | ok | 1234 | true | 2 | 0 |");
    expect(block).toContain("| step B | ok | 500 | false | 0 | 3 |");
    expect(block).toContain("| step C | ok | 100 | compat | 1 | 1 |");
  });

  it("escapes a pipe inside a step's own text without corrupting the table", () => {
    const stepRecord = makeStepRecord({
      started_at: "2026-08-01T00:00:00.000Z",
      finished_at: "2026-08-01T00:00:00.100Z",
      mutates: true,
      observed: { http_reads: 0, http_writes: 0 },
    });
    const stepRecords = new Map<string, StepRecord | null>([["r-1", stepRecord]]);
    const scenario = scenarioWithSteps([scenarioStep("a step | with a pipe in it", "r-1")], stepRecords);

    const markdown = renderAcceptanceRecord(baseOptions([scenario]));
    const block = scenarioBlock(markdown, "### a customer checks out (line 2)");

    expect(tableDataRows(block)).toHaveLength(1);
    expect(block).toContain("| a step \\| with a pipe in it | ok | 100 | true | 0 | 0 |");
  });
});
