import { describe, expect, it } from "vitest";
import { parseFeatureSource } from "../src/feature/load-features.js";
import { mapScenario, statusForKind } from "../src/report/allure/map-scenario.js";
import type { Receipt } from "../src/receipt/types.js";
import type { ErrorKind } from "../src/receipt/types.js";
import type { ScenarioHookRecord, ScenarioRecord, ScenarioStepRecord } from "../src/run/record-types.js";

// Responsibility: unit tests for map-scenario.ts's pure transform (this
// task's spec, test item 1). No allure-js-commons, no filesystem: every
// receipt is a plain object built in memory, and every GherkinDocument/
// Pickle comes from parsing an inline feature source string with the
// existing src/feature/load-features.ts entry point (no `.feature` file on
// disk needed).

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
    scenario_id: "scn-1",
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

describe("mapScenario: status mapping", () => {
  const ALL_KINDS: readonly ErrorKind[] = [
    "args_invalid",
    "result_invalid",
    "binding_invalid",
    "world_invalid",
    "timeout",
    "unsupported",
    "step_error",
  ];

  it.each(ALL_KINDS)("maps a failed receipt of kind %s to the right status with a marked message", (kind) => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "failed",
      error: { message: "it broke", kind },
    });
    delete (receipt as { result?: unknown }).result;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "failed", receipt: "rcpt-1" };
    const record = baseRecord({ status: "failed", steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.status).toBe(statusForKind(kind));
    expect(mapped.steps[0]!.message).toBe(`[nukadoko.failure=${kind}] it broke`);
  });

  it("maps undefined to broken with the record's plain message (no marker)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = {
      text: "an unknown step",
      status: "undefined",
      receipt: null,
      error: { message: "no matching step definition" },
    };
    const record = baseRecord({ status: "failed", steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.status).toBe("broken");
    expect(mapped.steps[0]!.message).toBe("no matching step definition");
  });

  it("maps ambiguous to broken with the record's plain message (no marker)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = {
      text: "an ambiguous step",
      status: "ambiguous",
      receipt: null,
      error: { message: "matched more than one step definition" },
    };
    const record = baseRecord({ status: "failed", steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.status).toBe("broken");
    expect(mapped.steps[0]!.message).toBe("matched more than one step definition");
  });

  it("maps skipped to skipped with no message", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = { text: "a step that never ran", status: "skipped", receipt: null };
    const record = baseRecord({ status: "failed", steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.status).toBe("skipped");
    expect(mapped.steps[0]!.message).toBeUndefined();
  });
});

describe("mapScenario: test.message (M3-C spec item 1)", () => {
  it("sets test.message to the first failure's own marked message, same as the step's own message", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({ status: "failed", error: { message: "it broke", kind: "step_error" } });
    delete (receipt as { result?: unknown }).result;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "failed", receipt: "rcpt-1" };
    const record = baseRecord({ status: "failed", steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.test.message).toBe("[nukadoko.failure=step_error] it broke");
    expect(mapped.test.message).toBe(mapped.steps[0]!.message);
  });

  it("leaves test.message undefined for a passed scenario", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({ status: "ok", result: null });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.test.message).toBeUndefined();
  });

  it("sets test.message from a before hook's own failure when it is the first failure", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const beforeHook: ScenarioHookRecord = {
      type: "before",
      status: "failed",
      error: { message: "hook blew up", kind: "step_error" },
    };
    const step: ScenarioStepRecord = { text: "the cart has items", status: "skipped", receipt: null };
    const record = baseRecord({ status: "failed", hooks: [beforeHook], steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.test.message).toBe("[nukadoko.failure=step_error] hook blew up");
    expect(mapped.test.labels).toContainEqual({ name: "nukadoko.failure", value: "step_error" });
  });

  it("sets test.message to the plain (unmarked) message when the first failure has no resolvable kind", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = {
      text: "an unknown step",
      status: "undefined",
      receipt: null,
      error: { message: "no matching step definition" },
    };
    const record = baseRecord({ status: "failed", steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.test.message).toBe("no matching step definition");
    expect(mapped.test.labels.some((l) => l.name === "nukadoko.failure")).toBe(false);
  });
});

describe("mapScenario: zero-width time for receiptless steps", () => {
  it("pins a receiptless step's start/stop to the previous step's own stop", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: "ok",
      started_at: "2026-08-01T00:00:00.500Z",
      finished_at: "2026-08-01T00:00:01.500Z",
    });
    const steps: ScenarioStepRecord[] = [
      { text: "the cart has items", status: "passed", receipt: "rcpt-1" },
      { text: "the customer pays", status: "skipped", receipt: null },
      {
        text: "the order is confirmed",
        status: "undefined",
        receipt: null,
        error: { message: "no matching step definition" },
      },
    ];
    const record = baseRecord({ status: "failed", steps });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    const stepTwoStopMs = Date.parse("2026-08-01T00:00:01.500Z");
    expect(mapped.steps[1]!.startMs).toBe(stepTwoStopMs);
    expect(mapped.steps[1]!.stopMs).toBe(stepTwoStopMs);
    // Chained: the third (also receiptless) step pins to the second's own
    // (already zero-width) stop, not back to the scenario's own start.
    expect(mapped.steps[2]!.startMs).toBe(stepTwoStopMs);
    expect(mapped.steps[2]!.stopMs).toBe(stepTwoStopMs);
  });

  it("pins the very first step, when receiptless, to the scenario's own started_at", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const step: ScenarioStepRecord = {
      text: "the cart has items",
      status: "undefined",
      receipt: null,
      error: { message: "no matching step definition" },
    };
    const record = baseRecord({
      status: "failed",
      started_at: "2026-08-01T00:00:00.000Z",
      steps: [step],
    });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    const scenarioStartMs = Date.parse("2026-08-01T00:00:00.000Z");
    expect(mapped.steps[0]!.startMs).toBe(scenarioStartMs);
    expect(mapped.steps[0]!.stopMs).toBe(scenarioStartMs);
  });
});

describe("mapScenario: step parameters", () => {
  it("reports mutates: null as 'not declared', not 'false'", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({ status: "ok", result: null, mutates: null });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.parameters).toContainEqual({ name: "mutates (declared)", value: "not declared" });
  });

  it("reports mutates: true/false literally, plus observed http/world counts and used receipts", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      mutates: false,
      observed: { http_reads: 2, http_writes: 1 },
      world: { reads: ["a", "b"], writes: ["c"] },
      used: [{ receipt: "rcpt-0", step: "create-cart" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    const params = mapped.steps[0]!.parameters;
    expect(params).toContainEqual({ name: "receipt", value: "rcpt-1" });
    expect(params).toContainEqual({ name: "mutates (declared)", value: "false" });
    expect(params).toContainEqual({ name: "http reads (observed)", value: "2" });
    expect(params).toContainEqual({ name: "http writes (observed)", value: "1" });
    expect(params).toContainEqual({ name: "world reads (observed)", value: "a, b" });
    expect(params).toContainEqual({ name: "world writes (observed)", value: "c" });
    expect(params).toContainEqual({ name: "used receipts", value: "rcpt-0" });
  });
});

describe("mapScenario: declared attachments/links/labels/logs", () => {
  it("prefixes a declared attachment's name with 'declared: ' and points at evidence.dir", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      declared: { attachments: ["screenshot.png"] },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.attachments).toContainEqual({
      kind: "path",
      name: "declared: screenshot.png",
      contentType: "image/png",
      path: ".nukadoko/receipts/rcpt-1/screenshot.png",
    });
  });

  it("bubbles a step's declared.links up to the test's own links, unprefixed", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      declared: { links: [{ url: "https://issues.example/1", name: "issue-1" }] },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.test.links).toContainEqual({ url: "https://issues.example/1", name: "issue-1", type: undefined });
  });

  it("bubbles a step's declared.labels up to the test's own labels, raw", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      declared: { labels: [{ name: "custom", value: "v" }] },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.test.labels).toContainEqual({ name: "custom", value: "v" });
  });

  it("turns declared.logs into zero-width, passed child steps (p2-allure-measurement: unchanged regardless of MappedChildStep's own widened shape)", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      declared: { logs: ["hello from glue"] },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    const stepStartMs = Date.parse(receipt.started_at);
    expect(mapped.steps[0]!.childSteps).toEqual([
      { name: "hello from glue", startMs: stepStartMs, stopMs: stepStartMs, status: "passed" },
    ]);
  });

  it("does the same for a hook's own declared data, sourced from the scenario's own evidence.dir", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const hook: ScenarioHookRecord = {
      type: "before",
      status: "ok",
      declared: { attachments: ["hook-file.txt"], links: [{ url: "https://x/1" }], logs: ["hook log"] },
    };
    const record = baseRecord({ hooks: [hook], evidence: { dir: ".nukadoko/scenarios/scn-1", screenshots: [] } });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.hooks[0]!.attachments).toContainEqual({
      kind: "path",
      name: "declared: hook-file.txt",
      contentType: "text/plain",
      path: ".nukadoko/scenarios/scn-1/hook-file.txt",
    });
    const hookTimestampMs = Date.parse(record.started_at);
    expect(mapped.hooks[0]!.childSteps).toEqual([
      { name: "hook log", startMs: hookTimestampMs, stopMs: hookTimestampMs, status: "passed" },
    ]);
    expect(mapped.test.links).toContainEqual({ url: "https://x/1", name: undefined, type: undefined });
  });
});

describe("mapScenario: tag resolution", () => {
  it("resolves @allure.label.<name>:<value>, the = variant, and @allure.id, and passes other tags through raw", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ steps: [] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.test.labels).toContainEqual({ name: "severity", value: "critical" });
    expect(mapped.test.labels).toContainEqual({ name: "owner", value: "alice" });
    expect(mapped.test.labels).toContainEqual({ name: "ALLURE_ID", value: "42" });
    expect(mapped.test.labels).toContainEqual({ name: "tag", value: "@smoke" });

    // Resolved tags must never also appear as raw `tag` labels.
    const rawTagValues = mapped.test.labels.filter((l) => l.name === "tag").map((l) => l.value);
    expect(rawTagValues).toEqual(["@smoke"]);
  });
});

describe("mapScenario: description fallback", () => {
  it("uses the Scenario's own description when present", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ steps: [] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.test.description).toBe("A customer completes checkout successfully.");
  });

  it("falls back to the Feature's own description when the Scenario has none", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles.find((p) => p.name === "no description here")!;
    const record = baseRecord({ scenario: "no description here", steps: [] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.test.description).toBe("Handles the checkout flow.");
  });
});

describe("mapScenario: test-level context parameters", () => {
  it("marks environment/session/target_version excluded, and includes each only when applicable", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({
      steps: [],
      environment: "staging",
      session: "sess-1",
      target_version: "1.2.3",
    });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.test.parameters).toContainEqual({ name: "environment", value: "staging", excluded: true });
    expect(mapped.test.parameters).toContainEqual({ name: "session", value: "sess-1", excluded: true });
    expect(mapped.test.parameters).toContainEqual({ name: "target_version", value: "1.2.3", excluded: true });
  });

  it("omits session when null and target_version when absent", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const record = baseRecord({ steps: [], session: null });
    delete (record as { target_version?: string }).target_version;

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.test.parameters.some((p) => p.name === "session")).toBe(false);
    expect(mapped.test.parameters.some((p) => p.name === "target_version")).toBe(false);
  });

  it("puts each Examples row's own cells into test parameters, not excluded", () => {
    const { gherkinDocument, pickles } = parse();
    const outlineRows = pickles.filter((p) => p.name.startsWith("checkout as"));
    expect(outlineRows).toHaveLength(2);
    const record = baseRecord({ scenario: "checkout as <role>", steps: [] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle: outlineRows[0]!,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.test.parameters).toContainEqual({ name: "role", value: "guest" });
  });

  it("gives both Scenario Outline rows the same templateName (the unexpanded Scenario.name)", () => {
    const { gherkinDocument, pickles } = parse();
    const outlineRows = pickles.filter((p) => p.name.startsWith("checkout as"));
    const record = baseRecord({ scenario: "checkout as <role>", steps: [] });

    const mappedRow1 = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle: outlineRows[0]!,
      posixPath: "features/checkout.feature",
    });
    const mappedRow2 = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle: outlineRows[1]!,
      posixPath: "features/checkout.feature",
    });

    expect(mappedRow1.test.templateName).toBe("checkout as <role>");
    expect(mappedRow2.test.templateName).toBe("checkout as <role>");
    // ...whereas the expanded pickle name (`test.name`) genuinely differs
    // per row — the whole reason `testCaseId` (emitter.ts) must be built
    // from `templateName`, not `name`.
    expect(mappedRow1.test.name).not.toBe(mappedRow2.test.name);
  });
});

describe("mapScenario: step name gets a Gherkin keyword prefix", () => {
  it("prefixes each step's name with its own keyword and trailing space", () => {
    const { gherkinDocument, pickles } = parse();
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
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.name).toBe("Given the cart has items");
    expect(mapped.steps[1]!.name).toBe("When the customer pays");
    expect(mapped.steps[2]!.name).toBe("Then the order is confirmed");
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
    const steps: ScenarioStepRecord[] = [
      { text: "a clean cart", status: "passed", receipt: null },
      { text: "the customer pays", status: "passed", receipt: null },
    ];
    const record = baseRecord({ scenario: "checkout", steps });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/with-background.feature",
    });

    expect(mapped.steps[0]!.name).toBe("Given a clean cart");
    expect(mapped.steps[1]!.name).toBe("When the customer pays");
  });

  it("falls back to the bare step text when the keyword can't be resolved", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    // Only 3 pickle steps exist for this scenario; a 4th record step has no
    // matching pickle step to resolve a keyword from.
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
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[3]!.name).toBe("an extra step with no pickle counterpart");
  });
});

describe("mapScenario: declared parameters", () => {
  it("puts a step's declared parameter into the test's own parameters, not excluded, and not on the step itself", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      declared: { parameters: [{ name: "cart_id", value: "abc-123" }] },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.test.parameters).toContainEqual({ name: "cart_id", value: "abc-123" });
    const declaredParam = mapped.test.parameters.find((p) => p.name === "cart_id");
    expect(declaredParam?.excluded).toBeUndefined();
    expect(mapped.steps[0]!.parameters.some((p) => p.name === "cart_id")).toBe(false);
  });

  it("also bubbles a hook's own declared parameter into test.parameters", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const hook: ScenarioHookRecord = {
      type: "before",
      status: "ok",
      declared: { parameters: [{ name: "hook-param", value: "y" }] },
    };
    const record = baseRecord({ hooks: [hook], steps: [] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.test.parameters).toContainEqual({ name: "hook-param", value: "y" });
  });

  it("orders test.parameters as Examples cells, then declared parameters, then the excluded execution-context ones", () => {
    const { gherkinDocument, pickles } = parse();
    const outlineRows = pickles.filter((p) => p.name.startsWith("checkout as"));
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      declared: { parameters: [{ name: "declared-only", value: "x" }] },
    });
    const step: ScenarioStepRecord = { text: "a guest customer", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({
      scenario: "checkout as <role>",
      steps: [step],
      target_version: "1.2.3",
    });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle: outlineRows[0]!,
      posixPath: "features/checkout.feature",
    });

    const names = mapped.test.parameters.map((p) => p.name);
    expect(names).toEqual(["role", "declared-only", "environment", "target_version"]);
  });
});

// --- p2-allure-measurement task spec: sections + polls timeline, page_events
// parameters, and the full-receipt attachment ---

describe("mapScenario: sections + polls merged into one child-step timeline", () => {
  it("merges section and poll entries in ascending `at` order, regardless of each array's own order", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
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
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.childSteps.map((c) => c.name)).toEqual([
      "A",
      "B (2 attempts)",
      "C",
      "D (1 attempts)",
    ]);
  });

  it("keeps declared log child steps first, ahead of the sections/polls timeline", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      declared: { logs: ["from glue"] },
      sections: [{ label: "reached checkout", at: "2026-08-01T00:00:00.100Z" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.childSteps.map((c) => c.name)).toEqual(["from glue", "reached checkout"]);
  });

  it("gives a section a zero-width marker at its own `at`, status passed", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      sections: [{ label: "reached checkout", at: "2026-08-01T00:00:00.100Z" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    const at = Date.parse("2026-08-01T00:00:00.100Z");
    expect(mapped.steps[0]!.childSteps).toEqual([{ name: "reached checkout", startMs: at, stopMs: at, status: "passed" }]);
  });
});

describe("mapScenario: poll outcome -> status/startMs/stopMs, all three outcomes", () => {
  it("maps resolved/timed_out/failed to passed/failed/broken with startMs = at and stopMs = at + waited_ms", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      polls: [
        { description: "r", at: "2026-08-01T00:00:00.000Z", attempts: 3, waited_ms: 120, outcome: "resolved" },
        { description: "t", at: "2026-08-01T00:00:01.000Z", attempts: 40, waited_ms: 20000, outcome: "timed_out" },
        { description: "f", at: "2026-08-01T00:00:02.000Z", attempts: 5, waited_ms: 10, outcome: "failed" },
      ],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    const [resolved, timedOut, failed] = mapped.steps[0]!.childSteps;
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
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      polls: [{ at: "2026-08-01T00:00:00.000Z", attempts: 1, waited_ms: 0, outcome: "resolved" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.childSteps[0]!.name).toBe("poll (1 attempts)");
  });

  it("never clamps a timeline entry to the parent step's own start/stop range", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      started_at: "2026-08-01T00:00:01.000Z",
      finished_at: "2026-08-01T00:00:01.500Z",
      // Outside the receipt's own started_at/finished_at window: a real
      // anomaly this task's spec says to report as-is, not clip.
      sections: [{ label: "before the step even started", at: "2026-08-01T00:00:00.000Z" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    const sectionAt = Date.parse("2026-08-01T00:00:00.000Z");
    const stepStartMs = Date.parse(receipt.started_at);
    expect(sectionAt).toBeLessThan(stepStartMs);
    expect(mapped.steps[0]!.childSteps[0]!.startMs).toBe(sectionAt);
  });
});

// --- p3c-allure-actions task spec: actions merged into the same
// sections/polls timeline, plus the truncation marker ---

describe("mapScenario: actions merged into the sections/polls timeline", () => {
  it("merges an action alongside sections/polls in ascending `at` order", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      sections: [{ label: "A", at: "2026-08-01T00:00:00.100Z" }],
      polls: [{ description: "B", at: "2026-08-01T00:00:00.200Z", attempts: 1, waited_ms: 0, outcome: "resolved" }],
      actions: [
        { method: "goto", url: "/orders", ms: 50, outcome: "passed", at: "2026-08-01T00:00:00.300Z" },
      ],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.childSteps.map((c) => c.name)).toEqual(["A", "B (1 attempts)", "goto /orders"]);
  });

  it("names an expect action with its matcher and target, never its ms/timeout_ms", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
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
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    const at = Date.parse("2026-08-01T00:00:00.100Z");
    expect(mapped.steps[0]!.childSteps[0]).toEqual({
      name: "expect #late to.be.visible",
      startMs: at,
      stopMs: at + 1234,
      status: "passed",
    });
  });

  it("folds a negated expect's own `.not` into the matcher, so it never reads as its own opposite", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
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
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.childSteps[0]!.name).toBe("expect #late not to.be.visible");
  });

  it("names a non-expect action with its method and url when there is no selector", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      actions: [{ method: "goto", url: "/orders", ms: 50, outcome: "passed", at: "2026-08-01T00:00:00.100Z" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.childSteps[0]!.name).toBe("goto /orders");
  });

  it("maps outcome: failed to status failed", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      actions: [{ method: "click", selector: "#submit", ms: 10, outcome: "failed", at: "2026-08-01T00:00:00.100Z" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.childSteps[0]!.status).toBe("failed");
  });

  it("keeps a fixed sections -> polls -> actions order when all three tie on the exact same `at`", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const sameInstant = "2026-08-01T00:00:00.100Z";
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      sections: [{ label: "section", at: sameInstant }],
      polls: [{ description: "poll", at: sameInstant, attempts: 1, waited_ms: 0, outcome: "resolved" }],
      actions: [{ method: "click", selector: "#go", ms: 0, outcome: "passed", at: sameInstant }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.childSteps.map((c) => c.name)).toEqual(["section", "poll (1 attempts)", "click #go"]);
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
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      actions,
      truncated: { actions: 103 },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    const childSteps = mapped.steps[0]!.childSteps;
    const marker = childSteps[childSteps.length - 1]!;
    expect(marker.name).toBe("... 100 more actions not shown");
    expect(marker.status).toBe("passed");
    expect(marker.startMs).toBe(marker.stopMs);
    expect(marker.startMs).toBe(childSteps[childSteps.length - 2]!.stopMs);
  });

  it("adds no marker when actions is present but not truncated", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      actions: [{ method: "click", selector: "#go", ms: 5, outcome: "passed", at: "2026-08-01T00:00:00.100Z" }],
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.childSteps.map((c) => c.name)).toEqual(["click #go"]);
  });
});

describe("mapScenario: hook trace/actions (p3d-hook-trace task spec)", () => {
  it("attaches a hook's own trace with the playwright-trace contentType, relative to the scenario's evidence dir", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const hook: ScenarioHookRecord = { type: "before", status: "ok", trace: "hook-before-0.zip" };
    const record = baseRecord({ hooks: [hook], evidence: { dir: ".nukadoko/scenarios/scn-1", screenshots: [] } });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.hooks[0]!.attachments).toContainEqual({
      kind: "path",
      name: "trace",
      contentType: "application/vnd.allure.playwright-trace",
      path: ".nukadoko/scenarios/scn-1/hook-before-0.zip",
    });
  });

  it("omits any trace attachment when the hook never opened a chunk", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const hook: ScenarioHookRecord = { type: "after", status: "ok" };
    const record = baseRecord({ hooks: [hook] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.hooks[0]!.attachments.some((a) => a.name === "trace")).toBe(false);
  });

  it("maps a hook's own actions into child steps via the same mapTimelineChildSteps merge a step's receipt uses", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const hook: ScenarioHookRecord = {
      type: "before",
      status: "ok",
      actions: [{ method: "goto", url: "data:text/html,before-hook", ms: 5, outcome: "passed", at: "2026-08-01T00:00:00.100Z" }],
    };
    const record = baseRecord({ hooks: [hook], started_at: "2026-08-01T00:00:00.000Z" });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.hooks[0]!.childSteps.map((c) => c.name)).toEqual(["goto data:text/html,before-hook"]);
  });

  it("anchors a hook's own truncation marker to its collapsed timestamp, the same fallback a step anchors to its receipt's started_at", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    // No `actions` array at all alongside `truncated` — an edge case
    // record-types.ts's own type does not forbid, exercising the fallback
    // branch mapTimelineChildSteps takes when its own childSteps array is
    // still empty by the time it reaches the truncation marker.
    const hook: ScenarioHookRecord = { type: "before", status: "ok", truncated: { actions: 5 } };
    const record = baseRecord({ hooks: [hook], started_at: "2026-08-01T00:00:00.000Z" });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    const marker = mapped.hooks[0]!.childSteps[0]!;
    expect(marker.name).toBe("... 5 more actions not shown");
    // The before hook's own collapsed timestamp is the scenario's own
    // started_at (mapHooks's own doc comment) — same value this record's
    // `started_at` carries.
    expect(marker.startMs).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
    expect(marker.stopMs).toBe(marker.startMs);
  });

  it("keeps a hook's own declared child steps ahead of its actions timeline, same order as a step's", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const hook: ScenarioHookRecord = {
      type: "before",
      status: "ok",
      declared: { logs: ["did the thing"] },
      actions: [{ method: "goto", url: "/x", ms: 5, outcome: "passed", at: "2026-08-01T00:00:00.100Z" }],
    };
    const record = baseRecord({ hooks: [hook] });

    const mapped = mapScenario({
      record,
      receipts: new Map(),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.hooks[0]!.childSteps.map((c) => c.name)).toEqual(["did the thing", "goto /x"]);
  });
});

describe("mapScenario: page_events as step parameters", () => {
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
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      page_events: { console_errors: [consoleErrorEntry(1)] },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    const params = mapped.steps[0]!.parameters;
    expect(params).toContainEqual({ name: "console errors (observed)", value: "1" });
    expect(params.some((p) => p.name === "page errors (observed)")).toBe(false);
    expect(params.some((p) => p.name === "failed requests (observed)")).toBe(false);
  });

  it("reports the true total, not the shown count, once a category was truncated", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const shown = Array.from({ length: 100 }, (_, i) => consoleErrorEntry(i));
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      page_events: { console_errors: shown, truncated: { console_errors: 4213 } },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.parameters).toContainEqual({ name: "console errors (observed)", value: "100 of 4213" });
  });
});

describe("mapScenario: receipt.evidence.attachments (P9 task spec)", () => {
  it("maps each attachment by name, guessing contentType from file's own extension, relative to evidence.dir", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      evidence: {
        dir: ".nukadoko/receipts/rcpt-1",
        screenshots: [],
        attachments: [{ name: "orders.json", file: "orders.json", at: "2026-08-01T00:00:00.100Z" }],
      },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.attachments).toContainEqual({
      kind: "path",
      name: "orders.json",
      contentType: "application/json",
      path: ".nukadoko/receipts/rcpt-1/orders.json",
    });
  });

  it("falls back to application/octet-stream for an unrecognized extension, never guessing", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      evidence: {
        dir: ".nukadoko/receipts/rcpt-1",
        screenshots: [],
        attachments: [{ name: "dump.bin", file: "dump.bin", at: "2026-08-01T00:00:00.100Z" }],
      },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.attachments).toContainEqual({
      kind: "path",
      name: "dump.bin",
      contentType: "application/octet-stream",
      path: ".nukadoko/receipts/rcpt-1/dump.bin",
    });
  });

  it("uses name, not file, so a collision-disambiguated file still shows the step's own requested name", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({
      status: "ok",
      result: null,
      evidence: {
        dir: ".nukadoko/receipts/rcpt-1",
        screenshots: [],
        attachments: [
          { name: "dup.txt", file: "dup.txt", at: "2026-08-01T00:00:00.100Z" },
          { name: "dup.txt", file: "dup-2.txt", at: "2026-08-01T00:00:00.200Z" },
        ],
      },
    });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.attachments).toContainEqual({
      kind: "path",
      name: "dup.txt",
      contentType: "text/plain",
      path: ".nukadoko/receipts/rcpt-1/dup.txt",
    });
    expect(mapped.steps[0]!.attachments).toContainEqual({
      kind: "path",
      name: "dup.txt",
      contentType: "text/plain",
      path: ".nukadoko/receipts/rcpt-1/dup-2.txt",
    });
  });

  it("adds no attachments at all when evidence.attachments is absent", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({ status: "ok", result: null });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.attachments.some((a) => a.name === "orders.json")).toBe(false);
  });
});

describe("mapScenario: the whole receipt as a receipt.json attachment", () => {
  it("attaches it to a passed step, verbatim", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({ status: "ok", result: { ok: true } });
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
    const record = baseRecord({ steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.attachments).toContainEqual({
      kind: "buffer",
      name: "receipt.json",
      contentType: "application/json",
      content: JSON.stringify(receipt, null, 2),
      fileExtension: ".json",
    });
  });

  it("attaches it to a failed step just the same", () => {
    const { gherkinDocument, pickles } = parse();
    const pickle = pickles[0]!;
    const receipt = baseReceipt({ status: "failed", error: { message: "it broke", kind: "step_error" } });
    delete (receipt as { result?: unknown }).result;
    const step: ScenarioStepRecord = { text: "the cart has items", status: "failed", receipt: "rcpt-1" };
    const record = baseRecord({ status: "failed", steps: [step] });

    const mapped = mapScenario({
      record,
      receipts: new Map([["rcpt-1", receipt]]),
      gherkinDocument,
      pickle,
      posixPath: "features/checkout.feature",
    });

    expect(mapped.steps[0]!.attachments).toContainEqual({
      kind: "buffer",
      name: "receipt.json",
      contentType: "application/json",
      content: JSON.stringify(receipt, null, 2),
      fileExtension: ".json",
    });
  });
});
