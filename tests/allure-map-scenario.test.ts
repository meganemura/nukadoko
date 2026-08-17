import { describe, expect, it } from "vitest";
import { parseFeatureSource } from "../src/feature/load-features.js";
import {
  mapHooks,
  mapScenario,
  mapScenarioEvidence,
  mapStep,
  statusForKind,
  type MapScenarioInput,
  type MapStepInput,
} from "../src/report/allure/map-scenario.js";
import type { ErrorKind, StepRecord } from "../src/record/types.js";
import type { ScenarioHookRecord, ScenarioRecord, ScenarioStepRecord } from "../src/run/record-types.js";

// Responsibility: unit tests for map-scenario.ts's pure transform. No
// allure-js-commons, no filesystem: every step record is a plain object built
// in memory, and every GherkinDocument/Pickle comes from parsing an inline
// feature source string with the existing src/feature/load-features.ts
// entry point (no `.feature` file on disk needed).
//
// Rewritten around `mapStep` (one step -> one Allure test, decision 1)
// replacing the old scenario = test design (one scenario -> one test, every
// step a child of it). `mapHooks`/`mapScenarioEvidence` are exercised
// directly rather than through that old design's own aggregation, which no
// longer exists.
//
// `mapScenario` (this file's own later `describe` blocks) is not that old
// design revived: it produces one *additional* test alongside a scenario's
// own already-per-step tests, never in place of them, and it is the one
// function in this module whose whole point is for its own output to
// repeat identically across two separate calls describing two runs of the
// same scenario: the opposite of `mapStep`'s own `identityParameters`.

const FEATURE_SOURCE = `Feature: Checkout
  Handles the checkout flow.

  @allure.label.severity:critical @allure.label.owner=alice @allure.id:42 @smoke
  Scenario: a customer checks out
    A customer completes checkout successfully.

    Given the cart has items
    When the customer pays
    Then the order is confirmed

  Scenario Outline: checkout as <role>
    Given a <role> customer

    Examples:
      | role   |
      | guest  |
      | member |

  Scenario: no description here
    Given a plain step
`;

function parse() {
  return parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
}

function baseRecord(overrides: Partial<ScenarioRecord> = {}): ScenarioRecord {
  return {
    scenario_record_id: "scn-1",
    run_id: "run-1",
    feature: "features/checkout.feature",
    scenario: "a customer checks out",
    line: 5,
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

function baseStepRecord(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    step_record_id: "step-1",
    step: "the cart has items",
    kind: "run",
    args: {},
    result: null,
    status: "ok",
    environment: "default",
    session: null,
    scenario_record_id: "scn-1",
    started_at: "2026-08-01T00:00:00.500Z",
    finished_at: "2026-08-01T00:00:01.000Z",
    evidence: { dir: ".nukadoko/records/steps/step-1", screenshots: [] },
    observed: { http_reads: 0, http_writes: 0 },
    mutates: true,
    ...overrides,
  } as StepRecord;
}

/** A minimal, valid `MapStepInput` — every test below overrides only the
 * fields it actually cares about (the same "one baseline, spread + override"
 * convention `baseRecord`/`baseStepRecord` above already follow). */
function callMapStep(
  overrides: Partial<MapStepInput> & Pick<MapStepInput, "record" | "stepRecord" | "gherkinDocument" | "pickle">,
) {
  return mapStep({
    runId: "run-1",
    scenarioId: "scn-1",
    environment: "default",
    session: null,
    index: 0,
    finishedAt: new Date("2026-08-01T00:00:03.000Z"),
    posixPath: "features/checkout.feature",
    ...overrides,
  });
}

function callMapHooks(record: ScenarioRecord) {
  return mapHooks(record, Date.parse(record.started_at), Date.parse(record.finished_at));
}

/** A minimal, valid `MapScenarioInput`, the same "one baseline, spread +
 * override" convention as `callMapStep` above. */
function callMapScenario(
  overrides: Partial<MapScenarioInput> & Pick<MapScenarioInput, "record" | "gherkinDocument" | "pickle">,
) {
  return mapScenario({
    environment: "default",
    session: null,
    posixPath: "features/checkout.feature",
    ...overrides,
  });
}

describe("mapStep: status mapping", () => {
  const ALL_KINDS: readonly ErrorKind[] = [
    "args_invalid",
    "result_invalid",
    "binding_invalid",
    "world_invalid",
    "timeout",
    "unsupported",
    "step_error",
  ];

  it.each(ALL_KINDS)("maps a failed step record of kind %s to the right status with a marked message", (kind) => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "failed", error: { message: "it broke", kind } });
    delete (stepRecord as { result?: unknown }).result;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "failed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.status).toBe(statusForKind(kind));
    expect(mapped.message).toBe(`[nukadoko.failure=${kind}] it broke`);
  });

  it("maps undefined to broken with the record's plain message (no marker)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = {
      text: "an unknown step",
      status: "undefined",
      step_record_id: null,
      error: { message: "no matching step definition" },
    };

    const mapped = callMapStep({ record: step, stepRecord: null, gherkinDocument, pickle });

    expect(mapped.status).toBe("broken");
    expect(mapped.message).toBe("no matching step definition");
  });

  it("maps ambiguous to broken with the record's plain message (no marker)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = {
      text: "an ambiguous step",
      status: "ambiguous",
      step_record_id: null,
      error: { message: "matched more than one step definition" },
    };

    const mapped = callMapStep({ record: step, stepRecord: null, gherkinDocument, pickle });

    expect(mapped.status).toBe("broken");
    expect(mapped.message).toBe("matched more than one step definition");
  });

  it("maps skipped to skipped with no message", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "a step that never ran", status: "skipped", step_record_id: null };

    const mapped = callMapStep({ record: step, stepRecord: null, gherkinDocument, pickle });

    expect(mapped.status).toBe("skipped");
    expect(mapped.message).toBeUndefined();
  });

  it("falls back to the record's own coarse status for a 'failed' step with no usable step record (a never-began refusal)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = {
      text: "the cart has items",
      status: "failed",
      step_record_id: null,
      error: { message: "refused before it ever ran" },
    };

    const mapped = callMapStep({ record: step, stepRecord: null, gherkinDocument, pickle });

    expect(mapped.status).toBe("failed");
    expect(mapped.message).toBe("refused before it ever ran");
  });
});

describe("mapStep: statusDetails / nukadoko.failure label, per step now (M3-C spec item 1, retargeted by this task)", () => {
  it("sets message and the nukadoko.failure label for a failed step", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "failed", error: { message: "it broke", kind: "step_error" } });
    delete (stepRecord as { result?: unknown }).result;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "failed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.message).toBe("[nukadoko.failure=step_error] it broke");
    expect(mapped.labels).toContainEqual({ name: "nukadoko.failure", value: "step_error" });
  });

  it("leaves message undefined, and adds no nukadoko.failure label, for a passed step", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "ok", result: null });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.message).toBeUndefined();
    expect(mapped.labels.some((l) => l.name === "nukadoko.failure")).toBe(false);
  });

  it("sets message to the plain (unmarked) message, and adds no nukadoko.failure label, when the step has no resolvable kind", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = {
      text: "an unknown step",
      status: "undefined",
      step_record_id: null,
      error: { message: "no matching step definition" },
    };

    const mapped = callMapStep({ record: step, stepRecord: null, gherkinDocument, pickle });

    expect(mapped.message).toBe("no matching step definition");
    expect(mapped.labels.some((l) => l.name === "nukadoko.failure")).toBe(false);
  });
});

describe("mapStep: zero-width time for a step with no step record", () => {
  it("pins to the caller's own finishedAt (no scenario timeline to anchor within any more)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = {
      text: "the cart has items",
      status: "undefined",
      step_record_id: null,
      error: { message: "no matching step definition" },
    };
    const finishedAt = new Date("2026-08-01T00:00:02.345Z");

    const mapped = callMapStep({ record: step, stepRecord: null, gherkinDocument, pickle, finishedAt });

    expect(mapped.startMs).toBe(finishedAt.getTime());
    expect(mapped.stopMs).toBe(finishedAt.getTime());
  });

  it("uses the step record's own started_at/finished_at instead, when there is one, ignoring finishedAt entirely", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      started_at: "2026-08-01T00:00:00.500Z",
      finished_at: "2026-08-01T00:00:01.000Z",
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({
      record: step,
      stepRecord,
      gherkinDocument,
      pickle,
      finishedAt: new Date("2026-08-01T00:00:09.000Z"),
    });

    expect(mapped.startMs).toBe(Date.parse("2026-08-01T00:00:00.500Z"));
    expect(mapped.stopMs).toBe(Date.parse("2026-08-01T00:00:01.000Z"));
  });
});

describe("mapStep: identity-breaking parameters", () => {
  it("carries nukadoko.run/nukadoko.scenario/nukadoko.step, each mode: hidden and not excluded", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: null };

    const mapped = callMapStep({
      record: step,
      stepRecord: null,
      gherkinDocument,
      pickle,
      runId: "run-42",
      scenarioId: "scn-7",
      index: 3,
    });

    expect(mapped.parameters).toContainEqual({ name: "nukadoko.run", value: "run-42", mode: "hidden" });
    expect(mapped.parameters).toContainEqual({ name: "nukadoko.scenario", value: "scn-7", mode: "hidden" });
    expect(mapped.parameters).toContainEqual({ name: "nukadoko.step", value: "3", mode: "hidden" });
  });
});

describe("mapStep: step parameters", () => {
  it("reports mutates: null as 'not declared', not 'false'", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "ok", result: null, mutates: null });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.parameters).toContainEqual({ name: "mutates (declared)", value: "not declared" });
  });

  it("reports mutates: true/false literally, plus observed http/world counts and used step records", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      mutates: false,
      observed: { http_reads: 2, http_writes: 1 },
      world: { reads: ["a", "b"], writes: ["c"] },
      used: [{ step_record_id: "step-0", step: "create-cart" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.parameters).toContainEqual({ name: "step record id", value: "step-1" });
    expect(mapped.parameters).toContainEqual({ name: "mutates (declared)", value: "false" });
    expect(mapped.parameters).toContainEqual({ name: "http reads (observed)", value: "2" });
    expect(mapped.parameters).toContainEqual({ name: "http writes (observed)", value: "1" });
    expect(mapped.parameters).toContainEqual({ name: "world reads (observed)", value: "a, b" });
    expect(mapped.parameters).toContainEqual({ name: "world writes (observed)", value: "c" });
    expect(mapped.parameters).toContainEqual({ name: "used step records", value: "step-0" });
  });
});

describe("mapStep: declared attachments/links/labels/logs", () => {
  it("prefixes a declared attachment's name with 'declared: ' and points at evidence.dir", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "ok", result: null, declared: { attachments: ["screenshot.png"] } });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.attachments).toContainEqual({
      kind: "path",
      name: "declared: screenshot.png",
      contentType: "image/png",
      path: ".nukadoko/records/steps/step-1/screenshot.png",
    });
  });

  it("puts a step's own declared.links directly onto its own test's links, unprefixed", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      declared: { links: [{ url: "https://issues.example/1", name: "issue-1" }] },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.links).toContainEqual({ url: "https://issues.example/1", name: "issue-1", type: undefined });
  });

  it("puts a step's own declared.labels directly onto its own test's labels, raw", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "ok", result: null, declared: { labels: [{ name: "custom", value: "v" }] } });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.labels).toContainEqual({ name: "custom", value: "v" });
  });

  it("turns declared.logs into zero-width, passed child steps (unchanged regardless of MappedChildStep's own widened shape)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "ok", result: null, declared: { logs: ["hello from glue"] } });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    const stepStartMs = Date.parse(stepRecord.started_at);
    expect(mapped.childSteps).toEqual([
      { name: "hello from glue", startMs: stepStartMs, stopMs: stepStartMs, status: "passed" },
    ]);
  });
});

describe("mapHooks: declared attachments/logs land on the hook's own fixture; links/labels are dropped", () => {
  it("prefixes a hook's own declared attachment and sources it from the scenario's own evidence.dir", () => {
    const hook: ScenarioHookRecord = {
      type: "before",
      status: "ok",
      declared: { attachments: ["hook-file.txt"], links: [{ url: "https://x/1" }], logs: ["hook log"] },
    };
    const record = baseRecord({ hooks: [hook], evidence: { dir: ".nukadoko/records/scenarios/scn-1", screenshots: [] } });

    const mapped = callMapHooks(record);

    expect(mapped[0]!.hook.attachments).toContainEqual({
      kind: "path",
      name: "declared: hook-file.txt",
      contentType: "text/plain",
      path: ".nukadoko/records/scenarios/scn-1/hook-file.txt",
    });
    const hookTimestampMs = Date.parse(record.started_at);
    expect(mapped[0]!.hook.childSteps).toEqual([
      { name: "hook log", startMs: hookTimestampMs, stopMs: hookTimestampMs, status: "passed" },
    ]);
  });

  it("carries a hook's own declared parameter as declaredParameters, for the caller to put on that hook's own fixture", () => {
    const hook: ScenarioHookRecord = {
      type: "before",
      status: "ok",
      declared: { parameters: [{ name: "hook-param", value: "y" }] },
    };
    const record = baseRecord({ hooks: [hook] });

    const mapped = callMapHooks(record);

    expect(mapped[0]!.declaredParameters).toContainEqual({ name: "hook-param", value: "y" });
  });

  it("has no home for a hook's own declared link or label (a fixture has neither in the Allure model)", () => {
    const hook: ScenarioHookRecord = {
      type: "before",
      status: "ok",
      declared: { links: [{ url: "https://x/1" }], labels: [{ name: "custom", value: "v" }] },
    };
    const record = baseRecord({ hooks: [hook] });

    const mapped = callMapHooks(record);

    // Neither the hook mapping's own return shape, nor the fixture it
    // becomes, has a `links`/`labels` field to check — this test pins that
    // absence at the value level (`HookMapping`/`MappedHook` have no such
    // field at the type level either, which this same assertion would fail
    // to compile against if either type ever grew one back).
    expect("links" in mapped[0]!).toBe(false);
    expect("labels" in mapped[0]!).toBe(false);
    expect("links" in mapped[0]!.hook).toBe(false);
    expect("labels" in mapped[0]!.hook).toBe(false);
  });
});

describe("mapHooks: status/message mapping", () => {
  it("maps an ok hook to passed, no message", () => {
    const hook: ScenarioHookRecord = { type: "after", status: "ok" };
    const record = baseRecord({ hooks: [hook] });

    const mapped = callMapHooks(record);

    expect(mapped[0]!.hook.status).toBe("passed");
    expect(mapped[0]!.hook.message).toBeUndefined();
  });

  it("maps a failed hook through statusForKind, with a marked message", () => {
    const hook: ScenarioHookRecord = {
      type: "before",
      status: "failed",
      error: { message: "hook blew up", kind: "step_error" },
    };
    const record = baseRecord({ hooks: [hook] });

    const mapped = callMapHooks(record);

    expect(mapped[0]!.hook.status).toBe(statusForKind("step_error"));
    expect(mapped[0]!.hook.message).toBe("[nukadoko.failure=step_error] hook blew up");
  });
});

describe("mapScenarioEvidence: scenario-level browser evidence -> a synthetic fixture", () => {
  it("returns undefined when there is no trace and no screenshots", () => {
    const record = baseRecord({ evidence: { dir: ".nukadoko/records/scenarios/scn-1", screenshots: [] } });

    expect(mapScenarioEvidence(record)).toBeUndefined();
  });

  it("returns a passed 'after' fixture carrying the trace and every screenshot, anchored to finished_at", () => {
    const record = baseRecord({
      finished_at: "2026-08-01T00:00:05.000Z",
      evidence: {
        dir: ".nukadoko/records/scenarios/scn-1",
        trace: "trace.zip",
        screenshots: [{ file: "final.png", at: "2026-08-01T00:00:04.900Z" }],
      },
    });

    const mapped = mapScenarioEvidence(record);

    expect(mapped).toBeDefined();
    expect(mapped!.type).toBe("after");
    expect(mapped!.name).toBe("Scenario evidence");
    expect(mapped!.status).toBe("passed");
    const finishedMs = Date.parse("2026-08-01T00:00:05.000Z");
    expect(mapped!.startMs).toBe(finishedMs);
    expect(mapped!.stopMs).toBe(finishedMs);
    expect(mapped!.attachments).toContainEqual({
      kind: "path",
      name: "trace",
      contentType: "application/vnd.allure.playwright-trace",
      path: ".nukadoko/records/scenarios/scn-1/trace.zip",
    });
    expect(mapped!.attachments).toContainEqual({
      kind: "path",
      name: "final.png",
      contentType: "image/png",
      path: ".nukadoko/records/scenarios/scn-1/final.png",
    });
  });
});

describe("mapStep: tag resolution", () => {
  it("resolves @allure.label.<name>:<value>, the = variant, and @allure.id, and passes other tags through raw", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: null };

    const mapped = callMapStep({ record: step, stepRecord: null, gherkinDocument, pickle });

    expect(mapped.labels).toContainEqual({ name: "severity", value: "critical" });
    expect(mapped.labels).toContainEqual({ name: "owner", value: "alice" });
    expect(mapped.labels).toContainEqual({ name: "ALLURE_ID", value: "42" });
    expect(mapped.labels).toContainEqual({ name: "tag", value: "@smoke" });

    // Resolved tags must never also appear as raw `tag` labels.
    const rawTagValues = mapped.labels.filter((l) => l.name === "tag").map((l) => l.value);
    expect(rawTagValues).toEqual(["@smoke"]);
  });
});

describe("mapStep: description fallback", () => {
  it("uses the Scenario's own description when present", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: null };

    const mapped = callMapStep({ record: step, stepRecord: null, gherkinDocument, pickle });

    expect(mapped.description).toBe("A customer completes checkout successfully.");
  });

  it("falls back to the Feature's own description when the Scenario has none", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles.find((p) => p.name === "no description here")!;
    const step: ScenarioStepRecord = { text: "a plain step", status: "passed", step_record_id: null };

    const mapped = callMapStep({ record: step, stepRecord: null, gherkinDocument, pickle });

    expect(mapped.description).toBe("Handles the checkout flow.");
  });
});

describe("mapStep: execution-context parameters", () => {
  it("marks environment/session/target_version excluded, and includes each only when applicable", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: null };

    const mapped = callMapStep({
      record: step,
      stepRecord: null,
      gherkinDocument,
      pickle,
      environment: "staging",
      session: "sess-1",
      targetVersion: "1.2.3",
    });

    expect(mapped.parameters).toContainEqual({ name: "environment", value: "staging", excluded: true });
    expect(mapped.parameters).toContainEqual({ name: "session", value: "sess-1", excluded: true });
    expect(mapped.parameters).toContainEqual({ name: "target_version", value: "1.2.3", excluded: true });
  });

  it("omits session when null and target_version when absent", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: null };

    const mapped = callMapStep({ record: step, stepRecord: null, gherkinDocument, pickle, session: null });

    expect(mapped.parameters.some((p) => p.name === "session")).toBe(false);
    expect(mapped.parameters.some((p) => p.name === "target_version")).toBe(false);
  });

  it("puts each Examples row's own cells into the step's own parameters, not excluded", () => {
    const { gherkinDocument, pickles } = parse();
    const outlineRows = pickles.filter((p) => p.name.startsWith("checkout as"));
    expect(outlineRows).toHaveLength(2);
    const pickle = outlineRows[0]!;
    const step: ScenarioStepRecord = { text: pickle.steps[0]!.text, status: "passed", step_record_id: null };

    const mapped = callMapStep({ record: step, stepRecord: null, gherkinDocument, pickle });

    expect(mapped.parameters).toContainEqual({ name: "role", value: "guest" });
  });
});

describe("mapStep: name gets a Gherkin keyword prefix", () => {
  it("prefixes each step's name with its own keyword and trailing space", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const steps: ScenarioStepRecord[] = [
      { text: "the cart has items", status: "passed", step_record_id: null },
      { text: "the customer pays", status: "passed", step_record_id: null },
      { text: "the order is confirmed", status: "passed", step_record_id: null },
    ];

    const names = steps.map((step, index) =>
      callMapStep({ record: step, stepRecord: null, gherkinDocument, pickle, index }).name,
    );

    expect(names).toEqual(["Given the cart has items", "When the customer pays", "Then the order is confirmed"]);
  });

  it("resolves the keyword for a Background-origin pickle step too", () => {
    const source = `Feature: With background
  Background:
    Given a clean cart

  Scenario: checkout
    When the customer pays
`;
    const { gherkinDocument, pickles } = parseFeatureSource(source, "features/with-background.feature");
    const pickle = pickles[0]!;

    const backgroundStep = callMapStep({
      record: { text: "a clean cart", status: "passed", step_record_id: null },
      stepRecord: null,
      gherkinDocument,
      pickle,
      index: 0,
    });
    const scenarioStep = callMapStep({
      record: { text: "the customer pays", status: "passed", step_record_id: null },
      stepRecord: null,
      gherkinDocument,
      pickle,
      index: 1,
    });

    expect(backgroundStep.name).toBe("Given a clean cart");
    expect(scenarioStep.name).toBe("When the customer pays");
  });

  it("falls back to the bare step text when the keyword can't be resolved", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    // Only 3 pickle steps exist for this scenario; index 3 has no matching
    // pickle step to resolve a keyword from.
    const step: ScenarioStepRecord = {
      text: "an extra step with no pickle counterpart",
      status: "passed",
      step_record_id: null,
    };

    const mapped = callMapStep({ record: step, stepRecord: null, gherkinDocument, pickle, index: 3 });

    expect(mapped.name).toBe("an extra step with no pickle counterpart");
  });
});

describe("mapStep: declared parameters", () => {
  it("puts a step's declared parameter into its own parameters, not excluded", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      declared: { parameters: [{ name: "cart_id", value: "abc-123" }] },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.parameters).toContainEqual({ name: "cart_id", value: "abc-123" });
    const declaredParam = mapped.parameters.find((p) => p.name === "cart_id");
    expect(declaredParam?.excluded).toBeUndefined();
  });

  it("orders parameters as Examples cells, then step-record-derived ones, then declared, then excluded context, then hidden identity", () => {
    const { gherkinDocument, pickles } = parse();
    const outlineRows = pickles.filter((p) => p.name.startsWith("checkout as"));
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      declared: { parameters: [{ name: "declared-only", value: "x" }] },
    });
    const pickle = outlineRows[0]!;
    const step: ScenarioStepRecord = { text: pickle.steps[0]!.text, status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle, targetVersion: "1.2.3" });

    const names = mapped.parameters.map((p) => p.name);
    expect(names).toEqual([
      "role",
      "step record id",
      "mutates (declared)",
      "http reads (observed)",
      "http writes (observed)",
      "declared-only",
      "environment",
      "target_version",
      "nukadoko.run",
      "nukadoko.scenario",
      "nukadoko.step",
    ]);
  });
});

// --- sections + polls timeline, page_events
// parameters, and the full-step-record attachment ---

describe("mapStep: sections + polls merged into one child-step timeline", () => {
  it("merges section and poll entries in ascending `at` order, regardless of each array's own order", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      sections: [
        { label: "C", at: "2026-08-01T00:00:00.300Z" },
        { label: "A", at: "2026-08-01T00:00:00.100Z" },
      ],
      polls: [
        { description: "D", at: "2026-08-01T00:00:00.400Z", attempts: 1, waited_ms: 0, outcome: "resolved" },
        { description: "B", at: "2026-08-01T00:00:00.200Z", attempts: 2, waited_ms: 50, outcome: "resolved" },
      ],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.childSteps.map((c) => c.name)).toEqual(["A", "B (2 attempts)", "C", "D (1 attempts)"]);
  });

  it("keeps declared log child steps first, ahead of the sections/polls timeline", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      declared: { logs: ["from glue"] },
      sections: [{ label: "reached checkout", at: "2026-08-01T00:00:00.100Z" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.childSteps.map((c) => c.name)).toEqual(["from glue", "reached checkout"]);
  });

  it("gives a section a zero-width marker at its own `at`, status passed", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      sections: [{ label: "reached checkout", at: "2026-08-01T00:00:00.100Z" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    const at = Date.parse("2026-08-01T00:00:00.100Z");
    expect(mapped.childSteps).toEqual([{ name: "reached checkout", startMs: at, stopMs: at, status: "passed" }]);
  });
});

describe("mapStep: poll outcome -> status/startMs/stopMs, all three outcomes", () => {
  it("maps resolved/timed_out/failed to passed/failed/broken with startMs = at and stopMs = at + waited_ms", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      polls: [
        { description: "r", at: "2026-08-01T00:00:00.000Z", attempts: 3, waited_ms: 120, outcome: "resolved" },
        { description: "t", at: "2026-08-01T00:00:01.000Z", attempts: 40, waited_ms: 20000, outcome: "timed_out" },
        { description: "f", at: "2026-08-01T00:00:02.000Z", attempts: 5, waited_ms: 10, outcome: "failed" },
      ],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    const [resolved, timedOut, failed] = mapped.childSteps;
    const resolvedAt = Date.parse("2026-08-01T00:00:00.000Z");
    const timedOutAt = Date.parse("2026-08-01T00:00:01.000Z");
    const failedAt = Date.parse("2026-08-01T00:00:02.000Z");

    expect(resolved).toEqual({ name: "r (3 attempts)", startMs: resolvedAt, stopMs: resolvedAt + 120, status: "passed" });
    expect(timedOut).toEqual({
      name: "t (40 attempts)",
      startMs: timedOutAt,
      stopMs: timedOutAt + 20000,
      status: "failed",
    });
    expect(failed).toEqual({ name: "f (5 attempts)", startMs: failedAt, stopMs: failedAt + 10, status: "broken" });
  });

  it("falls back to the bare name 'poll' when no description was given", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      polls: [{ at: "2026-08-01T00:00:00.000Z", attempts: 1, waited_ms: 0, outcome: "resolved" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.childSteps[0]!.name).toBe("poll (1 attempts)");
  });

  it("never clamps a timeline entry to the parent step's own start/stop range", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      started_at: "2026-08-01T00:00:01.000Z",
      finished_at: "2026-08-01T00:00:01.500Z",
      // Outside the step record's own started_at/finished_at window: a real
      // anomaly reported as-is, not clipped.
      sections: [{ label: "before the step even started", at: "2026-08-01T00:00:00.000Z" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    const sectionAt = Date.parse("2026-08-01T00:00:00.000Z");
    const stepStartMs = Date.parse(stepRecord.started_at);
    expect(sectionAt).toBeLessThan(stepStartMs);
    expect(mapped.childSteps[0]!.startMs).toBe(sectionAt);
  });
});

// --- actions merged into the same
// sections/polls timeline, plus the truncation marker ---

describe("mapStep: actions merged into the sections/polls timeline", () => {
  it("merges an action alongside sections/polls in ascending `at` order", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      sections: [{ label: "A", at: "2026-08-01T00:00:00.100Z" }],
      polls: [{ description: "B", at: "2026-08-01T00:00:00.200Z", attempts: 1, waited_ms: 0, outcome: "resolved" }],
      actions: [{ method: "goto", url: "/orders", ms: 50, outcome: "passed", at: "2026-08-01T00:00:00.300Z" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.childSteps.map((c) => c.name)).toEqual(["A", "B (1 attempts)", "goto /orders"]);
  });

  it("names an expect action with its matcher and target, never its ms/timeout_ms", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      actions: [
        {
          method: "expect",
          expression: "to.be.visible",
          selector: "#late",
          timeout_ms: 5000,
          ms: 1234,
          outcome: "passed",
          at: "2026-08-01T00:00:00.100Z",
        },
      ],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    const at = Date.parse("2026-08-01T00:00:00.100Z");
    expect(mapped.childSteps[0]).toEqual({
      name: "expect #late to.be.visible",
      startMs: at,
      stopMs: at + 1234,
      status: "passed",
    });
  });

  it("folds a negated expect's own `.not` into the matcher, so it never reads as its own opposite", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      actions: [
        {
          method: "expect",
          expression: "to.be.visible",
          selector: "#late",
          is_not: true,
          ms: 10,
          outcome: "passed",
          at: "2026-08-01T00:00:00.100Z",
        },
      ],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.childSteps[0]!.name).toBe("expect #late not to.be.visible");
  });

  it("names a non-expect action with its method and url when there is no selector", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      actions: [{ method: "goto", url: "/orders", ms: 50, outcome: "passed", at: "2026-08-01T00:00:00.100Z" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.childSteps[0]!.name).toBe("goto /orders");
  });

  it("maps outcome: failed to status failed", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      actions: [{ method: "click", selector: "#submit", ms: 10, outcome: "failed", at: "2026-08-01T00:00:00.100Z" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.childSteps[0]!.status).toBe("failed");
  });

  it("keeps a fixed sections -> polls -> actions order when all three tie on the exact same `at`", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const sameInstant = "2026-08-01T00:00:00.100Z";
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      sections: [{ label: "section", at: sameInstant }],
      polls: [{ description: "poll", at: sameInstant, attempts: 1, waited_ms: 0, outcome: "resolved" }],
      actions: [{ method: "click", selector: "#go", ms: 0, outcome: "passed", at: sameInstant }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.childSteps.map((c) => c.name)).toEqual(["section", "poll (1 attempts)", "click #go"]);
  });

  it("appends one zero-width, passed marker naming the cut when actions was truncated", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const actions = Array.from({ length: 3 }, (_, index) => ({
      method: "click",
      selector: `#item-${index}`,
      ms: 5,
      outcome: "passed" as const,
      at: `2026-08-01T00:00:00.${String(100 + index).padStart(3, "0")}Z`,
    }));
    const stepRecord = baseStepRecord({ status: "ok", result: null, actions, truncated: { actions: 103 } });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    const childSteps = mapped.childSteps;
    const marker = childSteps[childSteps.length - 1]!;
    expect(marker.name).toBe("... 100 more actions not shown");
    expect(marker.status).toBe("passed");
    expect(marker.startMs).toBe(marker.stopMs);
    expect(marker.startMs).toBe(childSteps[childSteps.length - 2]!.stopMs);
  });

  it("adds no marker when actions is present but not truncated", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      actions: [{ method: "click", selector: "#go", ms: 5, outcome: "passed", at: "2026-08-01T00:00:00.100Z" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.childSteps.map((c) => c.name)).toEqual(["click #go"]);
  });
});

describe("mapHooks: hook trace/actions", () => {
  it("attaches a hook's own trace with the playwright-trace contentType, relative to the scenario's evidence dir", () => {
    const hook: ScenarioHookRecord = { type: "before", status: "ok", trace: "hook-before-0.zip" };
    const record = baseRecord({ hooks: [hook], evidence: { dir: ".nukadoko/records/scenarios/scn-1", screenshots: [] } });

    const mapped = callMapHooks(record);

    expect(mapped[0]!.hook.attachments).toContainEqual({
      kind: "path",
      name: "trace",
      contentType: "application/vnd.allure.playwright-trace",
      path: ".nukadoko/records/scenarios/scn-1/hook-before-0.zip",
    });
  });

  it("omits any trace attachment when the hook never opened a chunk", () => {
    const hook: ScenarioHookRecord = { type: "after", status: "ok" };
    const record = baseRecord({ hooks: [hook] });

    const mapped = callMapHooks(record);

    expect(mapped[0]!.hook.attachments.some((a) => a.name === "trace")).toBe(false);
  });

  it("maps a hook's own actions into child steps via the same mapTimelineChildSteps merge a step's step record uses", () => {
    const hook: ScenarioHookRecord = {
      type: "before",
      status: "ok",
      actions: [{ method: "goto", url: "data:text/html,before-hook", ms: 5, outcome: "passed", at: "2026-08-01T00:00:00.100Z" }],
    };
    const record = baseRecord({ hooks: [hook], started_at: "2026-08-01T00:00:00.000Z" });

    const mapped = callMapHooks(record);

    expect(mapped[0]!.hook.childSteps.map((c) => c.name)).toEqual(["goto data:text/html,before-hook"]);
  });

  it("anchors a hook's own truncation marker to its collapsed timestamp, the same fallback a step anchors to its step record's started_at", () => {
    // No `actions` array at all alongside `truncated` — an edge case
    // record-types.ts's own type does not forbid, exercising the fallback
    // branch mapTimelineChildSteps takes when its own childSteps array is
    // still empty by the time it reaches the truncation marker.
    const hook: ScenarioHookRecord = { type: "before", status: "ok", truncated: { actions: 5 } };
    const record = baseRecord({ hooks: [hook], started_at: "2026-08-01T00:00:00.000Z" });

    const mapped = callMapHooks(record);

    const marker = mapped[0]!.hook.childSteps[0]!;
    expect(marker.name).toBe("... 5 more actions not shown");
    // The before hook's own collapsed timestamp is the scenario's own
    // started_at (mapHooks's own doc comment) — same value this record's
    // `started_at` carries.
    expect(marker.startMs).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
    expect(marker.stopMs).toBe(marker.startMs);
  });

  it("keeps a hook's own declared child steps ahead of its actions timeline, same order as a step's", () => {
    const hook: ScenarioHookRecord = {
      type: "before",
      status: "ok",
      declared: { logs: ["did the thing"] },
      actions: [{ method: "goto", url: "/x", ms: 5, outcome: "passed", at: "2026-08-01T00:00:00.100Z" }],
    };
    const record = baseRecord({ hooks: [hook] });

    const mapped = callMapHooks(record);

    expect(mapped[0]!.hook.childSteps.map((c) => c.name)).toEqual(["did the thing", "goto /x"]);
  });
});

describe("mapStep: page_events as step parameters", () => {
  function consoleErrorEntry(index: number) {
    return {
      text: `error ${index}`,
      location: { url: "https://example/app.js", lineNumber: 1, columnNumber: 1 },
      at: "2026-08-01T00:00:00.100Z",
    };
  }

  it("shows only the non-empty categories, each as an (observed) parameter", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "ok", result: null, page_events: { console_errors: [consoleErrorEntry(1)] } });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.parameters).toContainEqual({ name: "console errors (observed)", value: "1" });
    expect(mapped.parameters.some((p) => p.name === "page errors (observed)")).toBe(false);
    expect(mapped.parameters.some((p) => p.name === "failed requests (observed)")).toBe(false);
  });

  it("reports the true total, not the shown count, once a category was truncated", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const shown = Array.from({ length: 100 }, (_, i) => consoleErrorEntry(i));
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      page_events: { console_errors: shown, truncated: { console_errors: 4213 } },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.parameters).toContainEqual({ name: "console errors (observed)", value: "100 of 4213" });
  });
});

describe("mapStep: step record evidence.attachments", () => {
  it("maps each attachment by name, guessing contentType from file's own extension, relative to evidence.dir", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      evidence: {
        dir: ".nukadoko/records/steps/step-1",
        screenshots: [],
        attachments: [{ name: "orders.json", file: "orders.json", at: "2026-08-01T00:00:00.100Z" }],
      },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.attachments).toContainEqual({
      kind: "path",
      name: "orders.json",
      contentType: "application/json",
      path: ".nukadoko/records/steps/step-1/orders.json",
    });
  });

  it("falls back to application/octet-stream for an unrecognized extension, never guessing", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      evidence: {
        dir: ".nukadoko/records/steps/step-1",
        screenshots: [],
        attachments: [{ name: "dump.bin", file: "dump.bin", at: "2026-08-01T00:00:00.100Z" }],
      },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.attachments).toContainEqual({
      kind: "path",
      name: "dump.bin",
      contentType: "application/octet-stream",
      path: ".nukadoko/records/steps/step-1/dump.bin",
    });
  });

  it("uses name, not file, so a collision-disambiguated file still shows the step's own requested name", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      evidence: {
        dir: ".nukadoko/records/steps/step-1",
        screenshots: [],
        attachments: [
          { name: "dup.txt", file: "dup.txt", at: "2026-08-01T00:00:00.100Z" },
          { name: "dup.txt", file: "dup-2.txt", at: "2026-08-01T00:00:00.200Z" },
        ],
      },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.attachments).toContainEqual({
      kind: "path",
      name: "dup.txt",
      contentType: "text/plain",
      path: ".nukadoko/records/steps/step-1/dup.txt",
    });
    expect(mapped.attachments).toContainEqual({
      kind: "path",
      name: "dup.txt",
      contentType: "text/plain",
      path: ".nukadoko/records/steps/step-1/dup-2.txt",
    });
  });

  it("adds no attachments at all when evidence.attachments is absent", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "ok", result: null });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.attachments.some((a) => a.name === "orders.json")).toBe(false);
  });
});

describe("mapStep: the whole step record as a record.json attachment", () => {
  it("attaches it to a passed step, verbatim", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "ok", result: { ok: true } });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.attachments).toContainEqual({
      kind: "buffer",
      name: "record.json",
      contentType: "application/json",
      content: JSON.stringify(stepRecord, null, 2),
      fileExtension: ".json",
    });
  });

  it("attaches it to a failed step just the same", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "failed", error: { message: "it broke", kind: "step_error" } });
    delete (stepRecord as { result?: unknown }).result;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "failed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.attachments).toContainEqual({
      kind: "buffer",
      name: "record.json",
      contentType: "application/json",
      content: JSON.stringify(stepRecord, null, 2),
      fileExtension: ".json",
    });
  });
});

describe("mapScenario: output is stable across runs of the same scenario", () => {
  it("gives the exact same name and parameters to two calls that only differ in scenario_record_id/run_id", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const first = callMapScenario({
      record: baseRecord({ scenario_record_id: "scn-run-1", run_id: "run-1", steps: [step] }),
      gherkinDocument,
      pickle,
    });
    const second = callMapScenario({
      record: baseRecord({ scenario_record_id: "scn-run-2", run_id: "run-2", steps: [step] }),
      gherkinDocument,
      pickle,
    });

    expect(second.name).toBe(first.name);
    expect(second.parameters).toEqual(first.parameters);
  });

  it("never folds scenario_record_id or run_id into its own parameters", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({
      scenario_record_id: "scn-should-not-leak",
      run_id: "run-should-not-leak",
      steps: [{ text: "the cart has items", status: "passed", step_record_id: null }],
    });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    const values = mapped.parameters.map((p) => p.value);
    expect(values).not.toContain("scn-should-not-leak");
    expect(values).not.toContain("run-should-not-leak");
  });
});

describe("mapScenario: two Scenario Outline rows sharing a name diverge via Examples parameters alone", () => {
  // The Examples table's own "label" column is never interpolated into the
  // step below, on purpose: both rows' own pickle steps read identically,
  // so nothing but `buildExampleParameters` can tell the two rows apart
  // here. Interpolating `<label>` into the step text too would let the
  // step-signature parameter (mapScenario's own extra safety net, next
  // `describe` block) carry the distinction instead, which would prove
  // that safety net works but not that Examples-value inclusion itself
  // does, the one fact this `describe` block exists to isolate.
  const OUTLINE_SOURCE = `Feature: Outline
  Scenario Outline: shared name
    Then a static step

    Examples:
      | label |
      | one   |
      | two   |
`;

  it("keeps the two rows' own step text identical, yet gives each its own label parameter and its own historyId-feeding parameter set", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(OUTLINE_SOURCE, "features/outline.feature");
    expect(pickles).toHaveLength(2);
    expect(pickles[0]!.steps[0]!.text).toBe(pickles[1]!.steps[0]!.text);

    const results = pickles.map((pickle) =>
      callMapScenario({
        record: baseRecord({ steps: [{ text: pickle.steps[0]!.text, status: "passed", step_record_id: null }] }),
        gherkinDocument,
        pickle,
      }),
    );

    const labelValues = results.map((r) => r.parameters.find((p) => p.name === "label")?.value);
    expect(labelValues).toEqual(["one", "two"]);
    expect(results[0]!.parameters).not.toEqual(results[1]!.parameters);

    // The hidden step-signature parameter, by contrast, is identical
    // between the two rows here (this fixture's own point, this
    // `describe` block's own header): Examples inclusion alone is what
    // keeps them apart, not mapScenario's own extra safety net.
    const stepSignatures = results.map((r) => r.parameters.find((p) => p.name === "nukadoko.scenario.steps")?.value);
    expect(stepSignatures[0]).toBe(stepSignatures[1]);
  });
});

describe("mapScenario: two scenarios sharing a name but not a Scenario Outline", () => {
  const DUPLICATE_NAME_SOURCE = `Feature: Duplicates
  Scenario: same name
    Given step A

  Scenario: same name
    Given step B
`;

  it("diverges via the hidden step-signature parameter when the two scenarios' own step text differs (not an Outline-only problem)", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(DUPLICATE_NAME_SOURCE, "features/duplicates.feature");
    expect(pickles).toHaveLength(2);
    expect(pickles[0]!.name).toBe(pickles[1]!.name);
    expect(pickles[0]!.steps[0]!.text).not.toBe(pickles[1]!.steps[0]!.text);

    const results = pickles.map((pickle) =>
      callMapScenario({
        record: baseRecord({ steps: [{ text: pickle.steps[0]!.text, status: "passed", step_record_id: null }] }),
        gherkinDocument,
        pickle,
      }),
    );

    // Neither pickle has an Examples row of its own (not a Scenario
    // Outline), so `buildExampleParameters` contributes nothing for
    // either: only the hidden step-signature parameter tells them apart.
    const stepSignatures = results.map((r) => r.parameters.find((p) => p.name === "nukadoko.scenario.steps")?.value);
    expect(stepSignatures[0]).not.toBe(stepSignatures[1]);
    expect(results[0]!.parameters).not.toEqual(results[1]!.parameters);
  });

  it("accepted limit: two scenarios identical in both name and step text stay indistinguishable", () => {
    // A position-based tiebreaker was considered and rejected here for the
    // same reason mapStep never links a step across runs at all (this
    // module's own header): an inserted third same-name-and-steps
    // scenario would silently reassign which occurrence a later run's own
    // second row lands on, misattributing history rather than merely
    // losing it. This case is documented, not solved: genuinely nothing
    // in a Gherkin document distinguishes two scenarios this alike.
    const IDENTICAL_SOURCE = `Feature: Duplicates
  Scenario: same name
    Given the exact same step

  Scenario: same name
    Given the exact same step
`;
    const { gherkinDocument, pickles } = parseFeatureSource(IDENTICAL_SOURCE, "features/identical.feature");
    expect(pickles).toHaveLength(2);

    const results = pickles.map((pickle) =>
      callMapScenario({
        record: baseRecord({ steps: [{ text: pickle.steps[0]!.text, status: "passed", step_record_id: null }] }),
        gherkinDocument,
        pickle,
      }),
    );

    expect(results[0]!.parameters).toEqual(results[1]!.parameters);
  });
});

describe("mapScenario: parameter modes", () => {
  it("marks the step-signature parameter mode: hidden, and not excluded (it must still feed historyId)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ steps: [{ text: "the cart has items", status: "passed", step_record_id: null }] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    const param = mapped.parameters.find((p) => p.name === "nukadoko.scenario.steps");
    expect(param).toBeDefined();
    expect(param!.mode).toBe("hidden");
    expect(param!.excluded).toBeFalsy();
  });

  it("marks environment/session/target_version excluded, same convention as mapStep", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ steps: [] });

    const mapped = callMapScenario({
      record,
      gherkinDocument,
      pickle,
      environment: "staging",
      session: "sess-1",
      targetVersion: "9.9.9",
    });

    expect(mapped.parameters).toContainEqual({ name: "environment", value: "staging", excluded: true });
    expect(mapped.parameters).toContainEqual({ name: "session", value: "sess-1", excluded: true });
    expect(mapped.parameters).toContainEqual({ name: "target_version", value: "9.9.9", excluded: true });
  });
});

describe("mapScenario: name and labels", () => {
  it("prefixes the name with 'Scenario: ', never bare pickle.name (so its own leaf never echoes its own suite group heading verbatim)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ steps: [] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    expect(mapped.name).toBe(`Scenario: ${pickle.name}`);
  });

  it("carries a visible nukadoko.grain: scenario label", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ steps: [] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    expect(mapped.labels).toContainEqual({ name: "nukadoko.grain", value: "scenario" });
  });
});

describe("mapScenario: status, firstFailure classification, and child steps", () => {
  it("uses record.status directly", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;

    expect(callMapScenario({ record: baseRecord({ status: "passed", steps: [] }), gherkinDocument, pickle }).status).toBe(
      "passed",
    );
    expect(callMapScenario({ record: baseRecord({ status: "failed", steps: [] }), gherkinDocument, pickle }).status).toBe(
      "failed",
    );
  });

  it("adds no nukadoko.failure label and no message when firstFailure is not given, even for a failed scenario", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ status: "failed", steps: [] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    expect(mapped.labels.some((l) => l.name === "nukadoko.failure")).toBe(false);
    expect(mapped.message).toBeUndefined();
  });

  it("carries the first classified step failure's own kind as a label and its own message verbatim (so this test lands in a real category, not Allure's Product errors catch-all)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ status: "failed", steps: [] });

    const mapped = callMapScenario({
      record,
      gherkinDocument,
      pickle,
      firstFailure: { kind: "step_error", message: "[nukadoko.failure=step_error] it broke" },
    });

    expect(mapped.labels).toContainEqual({ name: "nukadoko.failure", value: "step_error" });
    expect(mapped.message).toBe("[nukadoko.failure=step_error] it broke");
  });

  it("maps each of the scenario record's own steps into a summary child step, undefined/ambiguous folding to broken", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const steps: ScenarioStepRecord[] = [
      { text: "a", status: "passed", step_record_id: "s1" },
      { text: "b", status: "failed", step_record_id: "s2" },
      { text: "c", status: "skipped", step_record_id: null },
      { text: "d", status: "undefined", step_record_id: null },
      { text: "e", status: "ambiguous", step_record_id: null },
    ];
    const record = baseRecord({ steps });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    expect(mapped.childSteps.map((c) => c.name)).toEqual(["a", "b", "c", "d", "e"]);
    expect(mapped.childSteps.map((c) => c.status)).toEqual(["passed", "failed", "skipped", "broken", "broken"]);
  });
});

describe("mapStep: calls -> nested child steps (docs/spec.md 'Parts')", () => {
  it("appends one call-derived child step named after the part, args/result as parameters, after the sections/polls/actions timeline", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: { memberId: "m_1" },
      sections: [{ label: "before the call", at: "2026-08-01T00:00:00.100Z" }],
      calls: [
        {
          step: "invite-member",
          args: { projectId: "p_1", email: "a@example.com" },
          result: { memberId: "m_1" },
          started_at: "2026-08-01T00:00:00.200Z",
          finished_at: "2026-08-01T00:00:00.900Z",
        },
      ],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.childSteps.map((c) => c.name)).toEqual(["before the call", "invite-member"]);
    const call = mapped.childSteps[1]!;
    expect(call.startMs).toBe(Date.parse("2026-08-01T00:00:00.200Z"));
    expect(call.stopMs).toBe(Date.parse("2026-08-01T00:00:00.900Z"));
    expect(call.status).toBe("passed");
    expect(call.parameters).toEqual([
      { name: "args", value: JSON.stringify({ projectId: "p_1", email: "a@example.com" }) },
      { name: "result", value: JSON.stringify({ memberId: "m_1" }) },
    ]);
  });

  it("omits the result parameter when the call carries none (a failed call)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "failed",
      error: { message: "never declared this part", kind: "step_error" },
      calls: [
        {
          step: "no-op-part",
          args: {},
          error: { message: "args validation failed", kind: "args_invalid" },
          started_at: "2026-08-01T00:00:00.200Z",
          finished_at: "2026-08-01T00:00:00.300Z",
        },
      ],
    });
    delete (stepRecord as { result?: unknown }).result;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "failed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    const call = mapped.childSteps[0]!;
    expect(call.parameters).toEqual([{ name: "args", value: JSON.stringify({}) }]);
    // `args_invalid` classifies to "broken" the same way statusForKind
    // already classifies a step record's own error of that kind — no
    // second classification invented for a call's own error.
    expect(call.status).toBe(statusForKind("args_invalid"));
  });

  it("nests a part-of-a-part call under its own caller's childSteps, not flattened alongside it", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: { memberId: "m_1" },
      calls: [
        {
          step: "invite-member",
          args: { projectId: "p_1", email: "a@example.com" },
          result: { memberId: "m_1" },
          started_at: "2026-08-01T00:00:00.200Z",
          finished_at: "2026-08-01T00:00:00.900Z",
          calls: [
            {
              step: "send-invite",
              args: { email: "a@example.com" },
              result: { sent: true, channel: "email" },
              started_at: "2026-08-01T00:00:00.300Z",
              finished_at: "2026-08-01T00:00:00.800Z",
            },
          ],
        },
      ],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    const call = mapped.childSteps[0]!;
    expect(call.name).toBe("invite-member");
    expect(call.childSteps).toEqual([
      {
        name: "send-invite",
        startMs: Date.parse("2026-08-01T00:00:00.300Z"),
        stopMs: Date.parse("2026-08-01T00:00:00.800Z"),
        status: "passed",
        parameters: [
          { name: "args", value: JSON.stringify({ email: "a@example.com" }) },
          { name: "result", value: JSON.stringify({ sent: true, channel: "email" }) },
        ],
        childSteps: [],
      },
    ]);
  });

  it("adds no call-derived child step at all when the step record carries no calls", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "ok", result: null });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const mapped = callMapStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.childSteps).toEqual([]);
  });
});
