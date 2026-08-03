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
      used: ["rcpt-0"],
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

  it("turns declared.logs into zero-width child steps", () => {
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

    expect(mapped.steps[0]!.childSteps).toEqual([{ name: "hello from glue" }]);
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
    expect(mapped.hooks[0]!.childSteps).toEqual([{ name: "hook log" }]);
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
