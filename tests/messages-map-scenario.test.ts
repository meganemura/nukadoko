import { HookType, IdGenerator, TestStepResultStatus, TimeConversion } from "@cucumber/messages";
import { describe, expect, it } from "vitest";
import { parseFeatureSource } from "../src/feature/load-features.js";
import { mapScenario } from "../src/report/messages/map-scenario.js";
import type { Receipt } from "../src/receipt/types.js";
import type { ScenarioHookRecord, ScenarioRecord, ScenarioStepRecord } from "../src/run/record-types.js";

// Responsibility: unit tests for map-scenario.ts's pure transform (this
// task's spec, test item 1). No node:fs, no real IdGenerator.uuid(): every
// receipt is a plain object built in memory, and `newId` is
// `IdGenerator.incrementing()` so assertions can pin exact ids (this task's
// spec, decision 11's own reason for threading `newId` through as an
// argument in the first place). Every `Pickle` comes from parsing an inline
// feature source string with the existing src/feature/load-features.ts
// entry point (no `.feature` file on disk needed) — this module never reads
// a `GherkinDocument` itself, but a real `Pickle`'s own `steps[].id` is what
// test item 3 (pickleStepId correspondence) needs to be genuine.

const FEATURE_SOURCE = `Feature: Checkout
  Scenario: a customer checks out
    Given the cart has items
    When the customer pays
    Then the order is confirmed
`;

function parse() {
  return parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
}

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

function baseReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    receipt_id: "rcpt-1",
    step: "the cart has items",
    kind: "run",
    args: {},
    result: null,
    status: "ok",
    environment: "default",
    session: null,
    scenario: "scn-1",
    started_at: "2026-08-01T00:00:00.500Z",
    finished_at: "2026-08-01T00:00:01.000Z",
    evidence: { dir: ".nukadoko/receipts/rcpt-1", screenshots: [] },
    observed: { http_reads: 0, http_writes: 0 },
    mutates: true,
    ...overrides,
  } as Receipt;
}

describe("mapScenario (messages): step status mapping", () => {
  const CASES: readonly [ScenarioStepRecord["status"], TestStepResultStatus][] = [
    ["passed", TestStepResultStatus.PASSED],
    ["failed", TestStepResultStatus.FAILED],
    ["skipped", TestStepResultStatus.SKIPPED],
    ["undefined", TestStepResultStatus.UNDEFINED],
    ["ambiguous", TestStepResultStatus.AMBIGUOUS],
  ];

  it.each(CASES)("maps step status %s to %s", (status, expected) => {
    const { pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "the cart has items", status, receipt: null };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      pickle,
      newId: IdGenerator.incrementing(),
      hookIds: {},
    });

    expect(mapped.steps[0]!.testStepFinished.testStepResult.status).toBe(expected);
  });
});

describe("mapScenario (messages): testSteps order and hookId absence", () => {
  it("orders testSteps as before hook -> step -> after hook", () => {
    const { pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: null };
    const beforeHook: ScenarioHookRecord = { type: "before", status: "ok" };
    const afterHook: ScenarioHookRecord = { type: "after", status: "ok" };
    const record = baseRecord({ steps: [step], hooks: [beforeHook, afterHook] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      pickle,
      newId: IdGenerator.incrementing(),
      hookIds: {},
    });

    expect(mapped.steps).toHaveLength(3);
    expect(mapped.steps[0]!.testStep.hookId).toBeDefined();
    expect(mapped.steps[0]!.testStep.pickleStepId).toBeUndefined();
    expect(mapped.steps[1]!.testStep.pickleStepId).toBeDefined();
    expect(mapped.steps[1]!.testStep.hookId).toBeUndefined();
    expect(mapped.steps[2]!.testStep.hookId).toBeDefined();
    expect(mapped.steps[2]!.testStep.pickleStepId).toBeUndefined();

    // testCase.testSteps is exactly the same sequence, in the same order.
    expect(mapped.testCase.testSteps.map((s) => s.id)).toEqual(mapped.steps.map((s) => s.testStep.id));

    // Exactly one new Hook envelope per type, since neither was already
    // assigned in `hookIds`.
    expect(mapped.newHooks).toHaveLength(2);
    expect(mapped.newHooks.map((h) => h.type).sort()).toEqual(["after", "before"]);
    expect(mapped.steps[0]!.testStep.hookId).toBe(mapped.newHooks.find((h) => h.type === "before")!.hook.id);
    expect(mapped.steps[2]!.testStep.hookId).toBe(mapped.newHooks.find((h) => h.type === "after")!.hook.id);
  });

  it("reuses an already-assigned hookId and emits no new Hook envelope for it", () => {
    const { pickles } = parse();
    const pickle = pickles[0]!;
    const beforeHook: ScenarioHookRecord = { type: "before", status: "ok" };
    const record = baseRecord({ steps: [], hooks: [beforeHook] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      pickle,
      newId: IdGenerator.incrementing(),
      hookIds: { before: "already-assigned-id" },
    });

    expect(mapped.newHooks).toHaveLength(0);
    expect(mapped.steps[0]!.testStep.hookId).toBe("already-assigned-id");
  });

  it("emits no hook-derived test step when the scenario record has no hooks", () => {
    const { pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: null };
    const record = baseRecord({ steps: [step], hooks: [] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      pickle,
      newId: IdGenerator.incrementing(),
      hookIds: {},
    });

    expect(mapped.steps).toHaveLength(1);
    expect(mapped.steps[0]!.testStep.hookId).toBeUndefined();
    expect(mapped.newHooks).toHaveLength(0);
  });
});

describe("mapScenario (messages): after_step hooks (t7-afterstep-consumers task spec, test item 1)", () => {
  it("gives an after_step hook its own HookType.AFTER_TEST_STEP Hook named AfterStep[<step_index>], not folded onto \"After\"", () => {
    const { pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: null };
    const afterStepHook: ScenarioHookRecord = { type: "after_step", status: "ok", step_index: 0 };
    const record = baseRecord({ steps: [step], hooks: [afterStepHook] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      pickle,
      newId: IdGenerator.incrementing(),
      hookIds: {},
    });

    expect(mapped.newHooks).toHaveLength(1);
    const newHook = mapped.newHooks[0]!;
    expect(newHook.type).toBe("after_step");
    expect(newHook.hook.name).toBe("AfterStep[0]");
    expect(newHook.hook.type).toBe(HookType.AFTER_TEST_STEP);

    // Detectable both by count (one hook-derived test step alongside the
    // one pickle-step test step) and by which step it names (this task's
    // spec, "テスト": "件数だけでなく、どの step の後かも"検出できる形で).
    expect(mapped.steps).toHaveLength(2);
    const afterStepTestStep = mapped.steps.find((s) => s.testStep.hookId !== undefined)!;
    expect(afterStepTestStep.testStep.hookId).toBe(newHook.hook.id);
  });

  it("orders testSteps as before -> pickle steps -> after_step -> after", () => {
    const { pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: null };
    const beforeHook: ScenarioHookRecord = { type: "before", status: "ok" };
    const afterStepHook: ScenarioHookRecord = { type: "after_step", status: "ok", step_index: 0 };
    const afterHook: ScenarioHookRecord = { type: "after", status: "ok" };
    const record = baseRecord({ steps: [step], hooks: [beforeHook, afterStepHook, afterHook] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      pickle,
      newId: IdGenerator.incrementing(),
      hookIds: {},
    });

    expect(mapped.steps).toHaveLength(4);
    expect(mapped.steps[0]!.testStep.hookId).toBe(mapped.newHooks.find((h) => h.type === "before")!.hook.id);
    expect(mapped.steps[1]!.testStep.pickleStepId).toBeDefined();
    expect(mapped.steps[2]!.testStep.hookId).toBe(mapped.newHooks.find((h) => h.type === "after_step")!.hook.id);
    expect(mapped.steps[3]!.testStep.hookId).toBe(mapped.newHooks.find((h) => h.type === "after")!.hook.id);

    expect(mapped.testCase.testSteps.map((s) => s.id)).toEqual(mapped.steps.map((s) => s.testStep.id));
  });

  it("gives distinct step_index values distinct Hook envelopes and distinct test steps", () => {
    const { pickles } = parse();
    const pickle = pickles[0]!;
    const steps: ScenarioStepRecord[] = [
      { text: "the cart has items", status: "passed", receipt: null },
      { text: "the customer pays", status: "passed", receipt: null },
    ];
    const hooks: ScenarioHookRecord[] = [
      { type: "after_step", status: "ok", step_index: 0 },
      { type: "after_step", status: "ok", step_index: 1 },
    ];
    const record = baseRecord({ steps, hooks });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      pickle,
      newId: IdGenerator.incrementing(),
      hookIds: {},
    });

    const afterStepHooks = mapped.newHooks.filter((h) => h.type === "after_step");
    expect(afterStepHooks).toHaveLength(2);
    expect(afterStepHooks.map((h) => h.hook.name).sort()).toEqual(["AfterStep[0]", "AfterStep[1]"]);
    expect(new Set(afterStepHooks.map((h) => h.hook.id)).size).toBe(2);
  });

  it("reuses two already-assigned hookIds.afterStep entries and emits no new Hook envelope for either", () => {
    const { pickles } = parse();
    const pickle = pickles[0]!;
    const steps: ScenarioStepRecord[] = [
      { text: "the cart has items", status: "passed", receipt: null },
      { text: "the customer pays", status: "passed", receipt: null },
    ];
    const hooks: ScenarioHookRecord[] = [
      { type: "after_step", status: "ok", step_index: 0 },
      { type: "after_step", status: "ok", step_index: 1 },
    ];
    const record = baseRecord({ steps, hooks });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      pickle,
      newId: IdGenerator.incrementing(),
      hookIds: { afterStep: { 0: "already-assigned-0", 1: "already-assigned-1" } },
    });

    expect(mapped.newHooks).toHaveLength(0);
    const hookSteps = mapped.steps.filter((s) => s.testStep.hookId !== undefined);
    expect(hookSteps.map((s) => s.testStep.hookId).sort()).toEqual(["already-assigned-0", "already-assigned-1"]);
  });

  it("collapses multiple after_step hook records for the same step_index onto one shared Hook id", () => {
    const { pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: null };
    const hooks: ScenarioHookRecord[] = [
      { type: "after_step", status: "ok", step_index: 0 },
      { type: "after_step", status: "failed", step_index: 0, error: { message: "boom", kind: "step_error" } },
    ];
    const record = baseRecord({ steps: [step], hooks });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      pickle,
      newId: IdGenerator.incrementing(),
      hookIds: {},
    });

    expect(mapped.newHooks.filter((h) => h.type === "after_step")).toHaveLength(1);
    const hookSteps = mapped.steps.filter((s) => s.testStep.hookId !== undefined);
    expect(hookSteps).toHaveLength(2);
    expect(hookSteps[0]!.testStep.hookId).toBe(hookSteps[1]!.testStep.hookId);
  });
});

describe("mapScenario (messages): pickleStepId correspondence", () => {
  it("sets pickleStepId to the matching pickle step's own id, in order", () => {
    const { pickles } = parse();
    const pickle = pickles[0]!;
    const steps: ScenarioStepRecord[] = [
      { text: "the cart has items", status: "passed", receipt: null },
      { text: "the customer pays", status: "passed", receipt: null },
      { text: "the order is confirmed", status: "passed", receipt: null },
    ];
    const record = baseRecord({ steps });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      pickle,
      newId: IdGenerator.incrementing(),
      hookIds: {},
    });

    expect(mapped.steps.map((s) => s.testStep.pickleStepId)).toEqual(pickle.steps.map((s) => s.id));
  });

  it("omits pickleStepId (but still emits the test step) when there is no matching pickle step", () => {
    const { pickles } = parse();
    const pickle = pickles[0]!;
    const steps: ScenarioStepRecord[] = [
      { text: "the cart has items", status: "passed", receipt: null },
      { text: "the customer pays", status: "passed", receipt: null },
      { text: "the order is confirmed", status: "passed", receipt: null },
      { text: "an extra step with no pickle counterpart", status: "passed", receipt: null },
    ];
    const record = baseRecord({ steps });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      pickle,
      newId: IdGenerator.incrementing(),
      hookIds: {},
    });

    expect(mapped.steps).toHaveLength(4);
    expect(mapped.steps[3]!.testStep.pickleStepId).toBeUndefined();
  });
});

describe("mapScenario (messages): duration/timestamp", () => {
  it("uses the receipt's own started_at/finished_at for a step's duration", () => {
    const { pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      started_at: "2026-08-01T00:00:00.500Z",
      finished_at: "2026-08-01T00:00:01.500Z",
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      pickle,
      newId: IdGenerator.incrementing(),
      hookIds: {},
    });

    const duration = mapped.steps[0]!.testStepFinished.testStepResult.duration;
    expect(TimeConversion.durationToMilliseconds(duration)).toBe(1000);
    expect(mapped.steps[0]!.testStepStarted.timestamp).toEqual(
      TimeConversion.millisecondsSinceEpochToTimestamp(Date.parse("2026-08-01T00:00:00.500Z")),
    );
  });

  it("gives a receiptless step duration 0, collapsed to the previous step's own stop", () => {
    const { pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      started_at: "2026-08-01T00:00:00.500Z",
      finished_at: "2026-08-01T00:00:01.500Z",
    });
    const steps: ScenarioStepRecord[] = [
      { text: "the cart has items", status: "passed", receipt: "rcpt-1" },
      { text: "the customer pays", status: "skipped", receipt: null },
    ];
    const record = baseRecord({ steps });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      pickle,
      newId: IdGenerator.incrementing(),
      hookIds: {},
    });

    const secondStopMs = Date.parse("2026-08-01T00:00:01.500Z");
    const duration = mapped.steps[1]!.testStepFinished.testStepResult.duration;
    expect(TimeConversion.durationToMilliseconds(duration)).toBe(0);
    expect(mapped.steps[1]!.testStepStarted.timestamp).toEqual(TimeConversion.millisecondsSinceEpochToTimestamp(secondStopMs));
    expect(mapped.steps[1]!.testStepFinished.timestamp).toEqual(TimeConversion.millisecondsSinceEpochToTimestamp(secondStopMs));
  });
});

describe("mapScenario (messages): failed step message, no exception", () => {
  it("copies record.error.message onto testStepResult.message, and never sets exception", () => {
    const { pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = {
      text: "the cart has items",
      status: "failed",
      receipt: null,
      error: { message: "it broke on purpose" },
    };
    const record = baseRecord({ status: "failed", steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      pickle,
      newId: IdGenerator.incrementing(),
      hookIds: {},
    });

    const result = mapped.steps[0]!.testStepFinished.testStepResult;
    expect(result.message).toBe("it broke on purpose");
    expect(result.exception).toBeUndefined();
  });
});
