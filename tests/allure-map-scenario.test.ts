import { describe, expect, it } from "vitest";
import type { Examples, GherkinDocument, Pickle, Scenario, TableRow } from "@cucumber/messages";
import { parseFeatureSource } from "../src/feature/load-features.js";
import {
  buildExampleParameters,
  mapGwtStep,
  mapHooks,
  mapScenario,
  statusForKind,
  type MapGwtStepInput,
  type MapScenarioInput,
  type MappedGwtStepOutcome,
} from "../src/report/allure/map-scenario.js";
import type { ErrorKind, StepRecord } from "../src/record/types.js";
import type { ScenarioHookRecord, ScenarioRecord, ScenarioStepRecord } from "../src/run/record-types.js";

// Responsibility: unit tests for map-scenario.ts's pure transform. No
// allure-js-commons, no filesystem: every step record is a plain object built
// in memory, and every GherkinDocument/Pickle comes from parsing an inline
// feature source string with the existing src/feature/load-features.ts
// entry point (no `.feature` file on disk needed).
//
// Rewritten around `mapGwtStep` (one pickle step -> one `steps[]` entry) and
// `mapScenario` (one pickle -> one Allure test result, folding every
// buffered `mapGwtStep` outcome plus this scenario's own hooks into it) —
// the official allure-cucumberjs grain, verified against a captured
// allure-cucumberjs 3.10.2 run. There is no longer a separate per-step test
// or a separate scenario-wide test to tell apart: `mapGwtStep`'s own output
// nests directly under the one result `mapScenario` returns.

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

/** A minimal, valid `MapGwtStepInput` — every test below overrides only the
 * fields it actually cares about (the same "one baseline, spread + override"
 * convention `baseRecord`/`baseStepRecord` above already follow). */
function callMapGwtStep(
  overrides: Partial<MapGwtStepInput> & Pick<MapGwtStepInput, "record" | "stepRecord" | "gherkinDocument" | "pickle">,
): MappedGwtStepOutcome {
  return mapGwtStep({
    index: 0,
    finishedAt: new Date("2026-08-01T00:00:03.000Z"),
    ...overrides,
  });
}

function callMapHooks(record: ScenarioRecord) {
  return mapHooks(record, Date.parse(record.started_at), Date.parse(record.finished_at));
}

/** A minimal, valid `MapScenarioInput` — `steps` defaults to `[]` for a test
 * that only cares about `record`/`gherkinDocument`/`pickle`-derived output
 * (name, description, tags, Examples parameters, package/feature labels);
 * a test exercising per-step data (declared labels/links, the classified-
 * failure search, the rendered `steps[]` array itself) overrides it with
 * real `mapGwtStep` outcomes. */
function callMapScenario(
  overrides: Partial<MapScenarioInput> & Pick<MapScenarioInput, "record" | "gherkinDocument" | "pickle">,
): ReturnType<typeof mapScenario> {
  return mapScenario({
    posixPath: "features/checkout.feature",
    projectName: null,
    steps: [],
    ...overrides,
  });
}

describe("mapGwtStep: status mapping", () => {
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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord: null, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord: null, gherkinDocument, pickle });

    expect(mapped.status).toBe("broken");
    expect(mapped.message).toBe("matched more than one step definition");
  });

  it("maps skipped to skipped with no message", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "a step that never ran", status: "skipped", step_record_id: null };

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord: null, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord: null, gherkinDocument, pickle });

    expect(mapped.status).toBe("failed");
    expect(mapped.message).toBe("refused before it ever ran");
  });
});

describe("mapGwtStep: outcome.failure, bubbled up for mapScenario's own classification search", () => {
  it("carries the classified kind and marked message for a failed step", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "failed", error: { message: "it broke", kind: "step_error" } });
    delete (stepRecord as { result?: unknown }).result;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "failed", step_record_id: "step-1" };

    const outcome = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(outcome.failure).toEqual({
      kind: "step_error",
      message: "[nukadoko.failure=step_error] it broke",
      rawMessage: "it broke",
    });
  });

  it("is undefined for a passed step", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "ok", result: null });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const outcome = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(outcome.failure).toBeUndefined();
  });

  it("is undefined when the step has no resolvable kind (undefined/ambiguous)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = {
      text: "an unknown step",
      status: "undefined",
      step_record_id: null,
      error: { message: "no matching step definition" },
    };

    const outcome = callMapGwtStep({ record: step, stepRecord: null, gherkinDocument, pickle });

    expect(outcome.failure).toBeUndefined();
  });
});

describe("mapGwtStep: zero-width time for a step with no step record", () => {
  it("pins to the caller's own finishedAt", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = {
      text: "the cart has items",
      status: "undefined",
      step_record_id: null,
      error: { message: "no matching step definition" },
    };
    const finishedAt = new Date("2026-08-01T00:00:02.345Z");

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord: null, gherkinDocument, pickle, finishedAt });

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

    const { step: mapped } = callMapGwtStep({
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

describe("mapGwtStep: no identity-breaking parameters (a steps[] entry has no history of its own to force apart)", () => {
  it("never adds nukadoko.run/nukadoko.scenario/nukadoko.step -- a steps[] entry has no history of its own to protect", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: null };

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord: null, gherkinDocument, pickle, index: 3 });

    const names = mapped.parameters.map((p) => p.name);
    expect(names).not.toContain("nukadoko.run");
    expect(names).not.toContain("nukadoko.scenario");
    expect(names).not.toContain("nukadoko.step");
  });
});

describe("mapGwtStep: step parameters", () => {
  it("reports mutates: null as 'not declared', not 'false'", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "ok", result: null, mutates: null });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.parameters).toContainEqual({ name: "step record id", value: "step-1" });
    expect(mapped.parameters).toContainEqual({ name: "mutates (declared)", value: "false" });
    expect(mapped.parameters).toContainEqual({ name: "http reads (observed)", value: "2" });
    expect(mapped.parameters).toContainEqual({ name: "http writes (observed)", value: "1" });
    expect(mapped.parameters).toContainEqual({ name: "world reads (observed)", value: "a, b" });
    expect(mapped.parameters).toContainEqual({ name: "world writes (observed)", value: "c" });
    expect(mapped.parameters).toContainEqual({ name: "used step records", value: "step-0" });
  });

  it("orders parameters as step-record-derived, then declared (no Examples/context/identity at step grain any more)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      declared: { parameters: [{ name: "declared-only", value: "x" }] },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.parameters.map((p) => p.name)).toEqual([
      "step record id",
      "mutates (declared)",
      "http reads (observed)",
      "http writes (observed)",
      "declared-only",
    ]);
  });
});

describe("mapGwtStep: declared attachments/logs; links/labels bubble up separately", () => {
  it("prefixes a declared attachment's name with 'declared: ' and points at evidence.dir", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "ok", result: null, declared: { attachments: ["screenshot.png"] } });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.attachments).toContainEqual({
      kind: "path",
      name: "declared: screenshot.png",
      contentType: "image/png",
      path: ".nukadoko/records/steps/step-1/screenshot.png",
    });
  });

  it("returns a step's own declared.links as declaredLinks, not on the steps[] entry (which has no links field)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      declared: { links: [{ url: "https://issues.example/1", name: "issue-1" }] },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const outcome = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(outcome.declaredLinks).toContainEqual({ url: "https://issues.example/1", name: "issue-1", type: undefined });
    expect("links" in outcome.step).toBe(false);
  });

  it("returns a step's own declared.labels as declaredLabels, not on the steps[] entry (which has no labels field)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "ok", result: null, declared: { labels: [{ name: "custom", value: "v" }] } });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const outcome = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(outcome.declaredLabels).toContainEqual({ name: "custom", value: "v" });
    expect("labels" in outcome.step).toBe(false);
  });

  it("turns declared.logs into zero-width, passed child steps", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "ok", result: null, declared: { logs: ["hello from glue"] } });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

    const stepStartMs = Date.parse(stepRecord.started_at);
    expect(mapped.childSteps).toEqual([
      { name: "hello from glue", startMs: stepStartMs, stopMs: stepStartMs, status: "passed" },
    ]);
  });
});

describe("mapGwtStep: Data table attachment", () => {
  const SOURCE = `Feature: Users
  Scenario: table users
    Given the following users:
      | name  | age |
      | Alice | 30  |
      | Bob   | 25  |
`;

  it("attaches the pickle step's own data table as 'Data table', text/csv, every row joined by newline", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(SOURCE, "features/users.feature");
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: pickle.steps[0]!.text, status: "passed", step_record_id: null };

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord: null, gherkinDocument, pickle, index: 0 });

    expect(mapped.attachments).toContainEqual({
      kind: "buffer",
      name: "Data table",
      contentType: "text/csv",
      content: "name,age\nAlice,30\nBob,25\n",
      fileExtension: ".csv",
    });
  });

  it("attaches no Data table when the step has no argument at all", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: null };

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord: null, gherkinDocument, pickle });

    expect(mapped.attachments.some((a) => a.name === "Data table")).toBe(false);
  });
});

describe("mapGwtStep: Doc string attachment (kept unlike the reference reporter)", () => {
  const SOURCE = `Feature: Notes
  Scenario: a note
    Given the following note:
      """
      This is a
      multi-line doc string
      """
`;

  it("attaches the pickle step's own doc string as 'Doc string', text/plain, content verbatim", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(SOURCE, "features/notes.feature");
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: pickle.steps[0]!.text, status: "passed", step_record_id: null };

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord: null, gherkinDocument, pickle, index: 0 });

    expect(mapped.attachments).toContainEqual({
      kind: "buffer",
      name: "Doc string",
      contentType: "text/plain",
      content: "This is a\nmulti-line doc string",
      fileExtension: ".txt",
    });
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

describe("mapScenario: scenario-wide browser evidence attaches directly to the result", () => {
  it("adds nothing when there is no trace and no screenshots", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ evidence: { dir: ".nukadoko/records/scenarios/scn-1", screenshots: [] } });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    expect(mapped.attachments).toEqual([]);
  });

  it("attaches the trace and every screenshot straight onto the result, no synthetic fixture involved", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({
      evidence: {
        dir: ".nukadoko/records/scenarios/scn-1",
        trace: "trace.zip",
        screenshots: [{ file: "final.png", at: "2026-08-01T00:00:04.900Z" }],
      },
    });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    expect(mapped.attachments).toContainEqual({
      kind: "path",
      name: "trace",
      contentType: "application/vnd.allure.playwright-trace",
      path: ".nukadoko/records/scenarios/scn-1/trace.zip",
    });
    expect(mapped.attachments).toContainEqual({
      kind: "path",
      name: "final.png",
      contentType: "image/png",
      path: ".nukadoko/records/scenarios/scn-1/final.png",
    });
  });
});

describe("mapScenario: Examples CSV attachment", () => {
  it("attaches the whole Examples table as 'Examples', text/csv, header then every row", () => {
    const { gherkinDocument, pickles } = parse();
    const outlineRows = pickles.filter((p) => p.name.startsWith("checkout as"));
    const record = baseRecord({ steps: [] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle: outlineRows[0]! });

    expect(mapped.attachments).toContainEqual({
      kind: "buffer",
      name: "Examples",
      contentType: "text/csv",
      content: "role\nguest\nmember\n",
      fileExtension: ".csv",
    });
  });

  it("gives both rows of the same outline the exact same Examples attachment", () => {
    const { gherkinDocument, pickles } = parse();
    const outlineRows = pickles.filter((p) => p.name.startsWith("checkout as"));
    const record = baseRecord({ steps: [] });

    const [first, second] = outlineRows.map((pickle) => callMapScenario({ record, gherkinDocument, pickle }));

    expect(first!.attachments).toEqual(second!.attachments);
  });

  it("attaches nothing for a scenario with no Examples table at all", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ steps: [] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    expect(mapped.attachments.some((a) => a.name === "Examples")).toBe(false);
  });
});

describe("mapScenario: package/feature labels, no parentSuite/suite", () => {
  it("includes the project name ahead of the posixPath's own dot-joined segments", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ steps: [] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle, projectName: "acme-checkout" });

    expect(mapped.labels).toContainEqual({ name: "package", value: "acme-checkout.features.checkout.feature" });
  });

  it("omits the project name entirely when there is none", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ steps: [] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle, projectName: null });

    expect(mapped.labels).toContainEqual({ name: "package", value: "features.checkout.feature" });
  });

  it("carries a feature label, and never parentSuite/suite (map-scenario.ts no longer assigns either)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ steps: [] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    expect(mapped.labels).toContainEqual({ name: "feature", value: "Checkout" });
    expect(mapped.labels.some((l) => l.name === "parentSuite")).toBe(false);
    expect(mapped.labels.some((l) => l.name === "suite")).toBe(false);
  });
});

describe("mapScenario: declared labels/links hoisted from every step (no other test left to hold them)", () => {
  it("folds a step's own declared label onto the result's own labels", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "ok", result: null, declared: { labels: [{ name: "custom", value: "v" }] } });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };
    const outcome = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });
    const record = baseRecord({ steps: [step] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle, steps: [outcome] });

    expect(mapped.labels).toContainEqual({ name: "custom", value: "v" });
  });

  it("folds a step's own declared link onto the result's own links, deduped", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      declared: { links: [{ url: "https://issues.example/1", name: "issue-1" }] },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };
    const outcome = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });
    const record = baseRecord({ steps: [step] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle, steps: [outcome, outcome] });

    expect(mapped.links).toEqual([{ url: "https://issues.example/1", name: "issue-1", type: undefined }]);
  });
});

describe("mapScenario: classified failure -- steps first, hooks as a fallback", () => {
  it("labels the result with the first failing step's own classified kind, and carries its message", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "failed", error: { message: "it broke", kind: "step_error" } });
    delete (stepRecord as { result?: unknown }).result;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "failed", step_record_id: "step-1" };
    const outcome = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });
    const record = baseRecord({ status: "failed", steps: [step] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle, steps: [outcome] });

    expect(mapped.labels).toContainEqual({ name: "nukadoko.failure", value: "step_error" });
    expect(mapped.message).toBe("[nukadoko.failure=step_error] it broke");
    expect(mapped.trace).toBe("it broke");
  });

  it("falls back to a classified Before hook failure when no step's own failure was classified (every step reads skipped)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "skipped", step_record_id: null };
    const outcome = callMapGwtStep({ record: step, stepRecord: null, gherkinDocument, pickle });
    const beforeHook: ScenarioHookRecord = { type: "before", status: "failed", error: { message: "hook blew up", kind: "step_error" } };
    const record = baseRecord({ status: "failed", steps: [step], hooks: [beforeHook] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle, steps: [outcome] });

    expect(mapped.labels).toContainEqual({ name: "nukadoko.failure", value: "step_error" });
    expect(mapped.message).toBe("[nukadoko.failure=step_error] hook blew up");
    expect(mapped.trace).toBe("hook blew up");
  });

  it("adds no nukadoko.failure label and no message/trace for a passed scenario, even if a hook happens to carry one (never searched)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ status: "passed", steps: [] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    expect(mapped.labels.some((l) => l.name === "nukadoko.failure")).toBe(false);
    expect(mapped.message).toBeUndefined();
    expect(mapped.trace).toBeUndefined();
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

    const stepSignatures = results.map((r) => r.parameters.find((p) => p.name === "nukadoko.scenario.steps")?.value);
    expect(stepSignatures[0]).not.toBe(stepSignatures[1]);
    expect(results[0]!.parameters).not.toEqual(results[1]!.parameters);
  });

  it("accepted limit: two scenarios identical in both name and step text stay indistinguishable", () => {
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

describe("mapScenario: parameter modes and context parameters read straight from record", () => {
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

  it("marks environment/session/target_version excluded, read from record fields directly", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({
      steps: [],
      environment: "staging",
      session: "sess-1",
      target_version: "9.9.9",
    });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    expect(mapped.parameters).toContainEqual({ name: "environment", value: "staging", excluded: true });
    expect(mapped.parameters).toContainEqual({ name: "session", value: "sess-1", excluded: true });
    expect(mapped.parameters).toContainEqual({ name: "target_version", value: "9.9.9", excluded: true });
  });

  it("omits session when null and target_version when absent", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ steps: [], session: null });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    expect(mapped.parameters.some((p) => p.name === "session")).toBe(false);
    expect(mapped.parameters.some((p) => p.name === "target_version")).toBe(false);
  });
});

describe("mapScenario: Examples row cells as visible parameters (every cell, argN fallback)", () => {
  it("puts each Examples row's own cells into the result's own parameters, not excluded", () => {
    const { gherkinDocument, pickles } = parse();
    const outlineRows = pickles.filter((p) => p.name.startsWith("checkout as"));
    const pickle = outlineRows[0]!;
    const record = baseRecord({ steps: [] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    expect(mapped.parameters).toContainEqual({ name: "role", value: "guest" });
  });

  it("names a cell with no header of its own arg<index>, never dropping it", () => {
    // Hand-built rather than parsed: Gherkin's own table syntax requires
    // every row (header included) to share one cell count, so a row wider
    // than its own header can't be expressed as real feature source at all
    // -- this exercises `buildExampleParameters`'s own defensive fallback
    // directly, the same "a row wider than its own header" case a
    // hand-rolled GherkinDocument (or a future gherkin-parser version with
    // looser validation) could still produce.
    const row: TableRow = {
      location: { line: 0 },
      id: "row-1",
      cells: [{ location: { line: 0 }, value: "guest" }, { location: { line: 0 }, value: "extra-value" }],
    };
    const examples: Examples = {
      location: { line: 0 },
      tags: [],
      keyword: "Examples",
      name: "",
      description: "",
      tableHeader: { location: { line: 0 }, id: "header-1", cells: [{ location: { line: 0 }, value: "role" }] },
      tableBody: [row],
      id: "examples-1",
    };
    const scenario: Scenario = {
      location: { line: 0 },
      tags: [],
      keyword: "Scenario Outline",
      name: "outline",
      description: "",
      steps: [],
      examples: [examples],
      id: "scenario-1",
    };
    const gherkinDocument: GherkinDocument = {
      comments: [],
      feature: {
        location: { line: 0 },
        tags: [],
        language: "en",
        keyword: "Feature",
        name: "Extra cell",
        description: "",
        children: [{ scenario }],
      },
    };
    const pickle: Pickle = {
      id: "pickle-1",
      uri: "features/extra-cell.feature",
      name: "outline",
      language: "en",
      steps: [],
      tags: [],
      astNodeIds: ["row-1"],
    };

    const params = buildExampleParameters(gherkinDocument, pickle);

    expect(params).toContainEqual({ name: "role", value: "guest" });
    expect(params).toContainEqual({ name: "arg1", value: "extra-value" });
  });

  it("returns [] for a scenario with no Examples row at all", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;

    expect(buildExampleParameters(gherkinDocument, pickle)).toEqual([]);
  });
});

describe("mapScenario: name, description, status, and steps[]", () => {
  it("uses bare pickle.name, never a 'Scenario: ' prefix (no second grain left to disambiguate from)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ steps: [] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    expect(mapped.name).toBe(pickle.name);
  });

  it("uses the Scenario's own description when present", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ steps: [] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    expect(mapped.description).toBe("A customer completes checkout successfully.");
  });

  it("falls back to the Feature's own description when the Scenario has none", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles.find((p) => p.name === "no description here")!;
    const record = baseRecord({ steps: [] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    expect(mapped.description).toBe("Handles the checkout flow.");
  });

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

  it("renders exactly the given steps' own mapped entries, in order -- never a re-derived summary", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepA: ScenarioStepRecord = { text: "a", status: "passed", step_record_id: null };
    const stepB: ScenarioStepRecord = { text: "b", status: "failed", step_record_id: null };
    const outcomeA = callMapGwtStep({ record: stepA, stepRecord: null, gherkinDocument, pickle, index: 0 });
    const outcomeB = callMapGwtStep({ record: stepB, stepRecord: null, gherkinDocument, pickle, index: 1 });
    const record = baseRecord({ steps: [stepA, stepB] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle, steps: [outcomeA, outcomeB] });

    expect(mapped.steps).toEqual([outcomeA.step, outcomeB.step]);
  });
});

describe("mapGwtStep: sections + polls merged into one child-step timeline", () => {
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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

    const at = Date.parse("2026-08-01T00:00:00.100Z");
    expect(mapped.childSteps).toEqual([{ name: "reached checkout", startMs: at, stopMs: at, status: "passed" }]);
  });
});

describe("mapGwtStep: poll outcome -> status/startMs/stopMs, all three outcomes", () => {
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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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
      sections: [{ label: "before the step even started", at: "2026-08-01T00:00:00.000Z" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

    const sectionAt = Date.parse("2026-08-01T00:00:00.000Z");
    const stepStartMs = Date.parse(stepRecord.started_at);
    expect(sectionAt).toBeLessThan(stepStartMs);
    expect(mapped.childSteps[0]!.startMs).toBe(sectionAt);
  });
});

describe("mapGwtStep: actions merged into the sections/polls timeline", () => {
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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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
    const hook: ScenarioHookRecord = { type: "before", status: "ok", truncated: { actions: 5 } };
    const record = baseRecord({ hooks: [hook], started_at: "2026-08-01T00:00:00.000Z" });

    const mapped = callMapHooks(record);

    const marker = mapped[0]!.hook.childSteps[0]!;
    expect(marker.name).toBe("... 5 more actions not shown");
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

describe("mapGwtStep: page_events as step parameters", () => {
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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.parameters).toContainEqual({ name: "console errors (observed)", value: "100 of 4213" });
  });
});

describe("mapGwtStep: step record evidence.attachments", () => {
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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.attachments.some((a) => a.name === "orders.json")).toBe(false);
  });
});

describe("mapGwtStep: the whole step record as a record.json attachment", () => {
  it("attaches it to a passed step, verbatim", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({ status: "ok", result: { ok: true } });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.attachments).toContainEqual({
      kind: "buffer",
      name: "record.json",
      contentType: "application/json",
      content: JSON.stringify(stepRecord, null, 2),
      fileExtension: ".json",
    });
  });
});

describe("mapGwtStep: name gets a Gherkin keyword prefix", () => {
  it("prefixes each step's name with its own keyword and trailing space", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const steps: ScenarioStepRecord[] = [
      { text: "the cart has items", status: "passed", step_record_id: null },
      { text: "the customer pays", status: "passed", step_record_id: null },
      { text: "the order is confirmed", status: "passed", step_record_id: null },
    ];

    const names = steps.map(
      (step, index) => callMapGwtStep({ record: step, stepRecord: null, gherkinDocument, pickle, index }).step.name,
    );

    expect(names).toEqual(["Given the cart has items", "When the customer pays", "Then the order is confirmed"]);
  });

  it("leaves an And step's own keyword exactly as written, never normalized to Given/When/Then", () => {
    const source = `Feature: And check
  Scenario: two steps
    Given a passing step
    And another passing step via And
`;
    const { gherkinDocument, pickles } = parseFeatureSource(source, "features/and-check.feature");
    const pickle = pickles[0]!;

    const { step: mapped } = callMapGwtStep({
      record: { text: "another passing step via And", status: "passed", step_record_id: null },
      stepRecord: null,
      gherkinDocument,
      pickle,
      index: 1,
    });

    expect(mapped.name).toBe("And another passing step via And");
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

    const backgroundStep = callMapGwtStep({
      record: { text: "a clean cart", status: "passed", step_record_id: null },
      stepRecord: null,
      gherkinDocument,
      pickle,
      index: 0,
    });
    const scenarioStep = callMapGwtStep({
      record: { text: "the customer pays", status: "passed", step_record_id: null },
      stepRecord: null,
      gherkinDocument,
      pickle,
      index: 1,
    });

    expect(backgroundStep.step.name).toBe("Given a clean cart");
    expect(scenarioStep.step.name).toBe("When the customer pays");
  });

  it("falls back to the bare step text when the keyword can't be resolved", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = {
      text: "an extra step with no pickle counterpart",
      status: "passed",
      step_record_id: null,
    };

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord: null, gherkinDocument, pickle, index: 3 });

    expect(mapped.name).toBe("an extra step with no pickle counterpart");
  });
});

describe("mapGwtStep: declared parameters", () => {
  it("puts a step's declared parameter into its own parameters, not excluded", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const stepRecord = baseStepRecord({
      status: "ok",
      result: null,
      declared: { parameters: [{ name: "cart_id", value: "abc-123" }] },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.parameters).toContainEqual({ name: "cart_id", value: "abc-123" });
    const declaredParam = mapped.parameters.find((p) => p.name === "cart_id");
    expect(declaredParam?.excluded).toBeUndefined();
  });
});

describe("mapGwtStep: calls -> nested child steps (docs/spec.md 'Parts')", () => {
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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

    const call = mapped.childSteps[0]!;
    expect(call.parameters).toEqual([{ name: "args", value: JSON.stringify({}) }]);
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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

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

    const { step: mapped } = callMapGwtStep({ record: step, stepRecord, gherkinDocument, pickle });

    expect(mapped.childSteps).toEqual([]);
  });
});

describe("mapGwtStep: tag resolution moved to mapScenario -- resolveTagLabels is scenario-wide now", () => {
  it("mapScenario resolves @allure.label.<name>:<value>, the = variant, and @allure.id, and passes other tags through raw", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ steps: [] });

    const mapped = callMapScenario({ record, gherkinDocument, pickle });

    expect(mapped.labels).toContainEqual({ name: "severity", value: "critical" });
    expect(mapped.labels).toContainEqual({ name: "owner", value: "alice" });
    expect(mapped.labels).toContainEqual({ name: "ALLURE_ID", value: "42" });
    expect(mapped.labels).toContainEqual({ name: "tag", value: "@smoke" });

    const rawTagValues = mapped.labels.filter((l) => l.name === "tag").map((l) => l.value);
    expect(rawTagValues).toEqual(["@smoke"]);
  });
});
