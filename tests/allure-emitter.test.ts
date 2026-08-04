import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFeatureSource } from "../src/feature/load-features.js";
import { createAllureEmitter, type AllureEmitter } from "../src/report/allure/emitter.js";
import type { Receipt } from "../src/receipt/types.js";
import type { ScenarioHookRecord, ScenarioRecord, ScenarioStepRecord } from "../src/run/record-types.js";
import { createCaptureSink } from "./helpers/fixtures.js";

// Responsibility: integration tests (this task's spec, test items 5-6) —
// drives the real allure-js-commons ReporterRuntime end to end against
// fixture record.json/receipt.json data (built here as plain objects, not
// by actually running a scenario) and reads the real files it writes back
// off disk. No `.feature` file on disk is needed either: `parseFeatureSource`
// takes source text directly.

const FEATURE_SOURCE = `Feature: Checkout
  Handles the checkout flow.

  Scenario: a customer checks out
    Given the cart has items

  Scenario Outline: checkout as <role>
    Given a <role> customer

    Examples:
      | role   |
      | guest  |
      | member |
`;

function writeReceiptFile(rootDir: string, receipt: Receipt): void {
  const dir = path.join(rootDir, ".nukadoko", "receipts", receipt.receipt_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}

function readResultFiles(resultsDir: string): Record<string, unknown>[] {
  return readdirSync(resultsDir)
    .filter((name) => name.endsWith("-result.json"))
    .map((name) => JSON.parse(readFileSync(path.join(resultsDir, name), "utf8")));
}

function readContainerFiles(resultsDir: string): Record<string, unknown>[] {
  return readdirSync(resultsDir)
    .filter((name) => name.endsWith("-container.json"))
    .map((name) => JSON.parse(readFileSync(path.join(resultsDir, name), "utf8")));
}

describe("createAllureEmitter", () => {
  let rootDir: string;
  let resultsDir: string;
  let sink: { write(chunk: string): boolean; text(): string };
  let emitter: AllureEmitter;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-allure-emitter-"));
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: "acme-checkout" }));
    resultsDir = path.join(rootDir, ".nukadoko", "allure-results");
    sink = createCaptureSink();
    emitter = createAllureEmitter({
      resultsDir,
      rootDir,
      environment: "staging",
      targetVersion: "9.9.9",
      secrets: [],
      stderr: sink,
    });
    emitter.begin();
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("writes categories.json (7 rules) and environment.properties on begin()", () => {
    const categories = JSON.parse(readFileSync(path.join(resultsDir, "categories.json"), "utf8"));
    expect(categories).toHaveLength(7);
    const env = readFileSync(path.join(resultsDir, "environment.properties"), "utf8");
    expect(env).toContain("environment=staging");
    expect(env).toContain("target_version=9.9.9");
  });

  describe("a full scenario with a passing step and before/after hooks", () => {
    let mappedTestUuid: string | undefined;

    beforeEach(() => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;

      const receiptDir = path.join(rootDir, ".nukadoko", "receipts", "rcpt-1");
      mkdirSync(receiptDir, { recursive: true });
      writeFileSync(path.join(receiptDir, "note.txt"), "declared note");
      writeFileSync(path.join(receiptDir, "http.jsonl"), '{"method":"GET","url":"https://x","status":200,"duration_ms":5}\n');

      const receipt: Receipt = {
        receipt_id: "rcpt-1",
        step: "the cart has items",
        kind: "run",
        args: {},
        result: { ok: true },
        status: "ok",
        environment: "staging",
        session: "sess-1",
        target_version: "9.9.9",
        scenario: "scn-1",
        started_at: "2026-08-01T00:00:00.500Z",
        finished_at: "2026-08-01T00:00:01.000Z",
        evidence: { dir: ".nukadoko/receipts/rcpt-1", screenshots: [], http: "http.jsonl" },
        observed: { http_reads: 1, http_writes: 0 },
        mutates: true,
        declared: {
          attachments: ["note.txt"],
          links: [{ url: "https://issue.example/1", name: "issue-1" }],
          logs: ["did the thing"],
        },
      };
      writeReceiptFile(rootDir, receipt);

      const scenarioDir = path.join(rootDir, ".nukadoko", "scenarios", "scn-1");
      mkdirSync(scenarioDir, { recursive: true });
      writeFileSync(path.join(scenarioDir, "trace.zip"), "trace bytes");
      writeFileSync(path.join(scenarioDir, "shot1.png"), "png bytes");
      writeFileSync(path.join(scenarioDir, "hook-note.txt"), "hook declared note");

      const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
      const beforeHook: ScenarioHookRecord = {
        type: "before",
        status: "ok",
        declared: { attachments: ["hook-note.txt"], logs: ["hook did something"] },
      };
      const afterHook: ScenarioHookRecord = { type: "after", status: "ok" };

      const record: ScenarioRecord = {
        scenario_id: "scn-1",
        run_id: "run-1",
        feature: "features/checkout.feature",
        scenario: "a customer checks out",
        line: 3,
        status: "passed",
        environment: "staging",
        session: "sess-1",
        target_version: "9.9.9",
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:02.000Z",
        steps: [step],
        hooks: [beforeHook, afterHook],
        evidence: {
          dir: ".nukadoko/scenarios/scn-1",
          trace: "trace.zip",
          screenshots: [{ file: "shot1.png", at: "2026-08-01T00:00:01.500Z" }],
        },
      };

      emitter.emitScenario({
        record,
        gherkinDocument,
        pickle,
        relativeFeaturePath: "features/checkout.feature",
      });

      const results = readResultFiles(resultsDir);
      const match = results.find((r) => (r as { name?: string }).name === "a customer checks out");
      mappedTestUuid = (match as { uuid?: string } | undefined)?.uuid;
    });

    it("writes one result.json with the expected labels/parameters/steps/attachments", () => {
      const results = readResultFiles(resultsDir);
      const test = results.find((r) => (r as { name?: string }).name === "a customer checks out") as {
        fullName?: string;
        status?: string;
        labels?: { name: string; value: string }[];
        parameters?: { name: string; value: string; excluded?: boolean }[];
        steps?: { name: string; status: string; parameters: { name: string; value: string }[]; attachments: { name: string; type: string }[] }[];
        attachments?: { name: string; type: string }[];
        links?: { url: string; name?: string }[];
      };

      expect(test).toBeDefined();
      expect(test.fullName).toBe("acme-checkout:features/checkout.feature#a customer checks out");
      expect(test.status).toBe("passed");

      expect(test.labels).toContainEqual({ name: "feature", value: "Checkout" });
      expect(test.labels).toContainEqual({ name: "package", value: "features.checkout.feature" });
      expect(test.labels).toContainEqual({ name: "env", value: "staging" });

      expect(test.parameters).toContainEqual({ name: "environment", value: "staging", excluded: true });
      expect(test.parameters).toContainEqual({ name: "session", value: "sess-1", excluded: true });
      expect(test.parameters).toContainEqual({ name: "target_version", value: "9.9.9", excluded: true });

      expect(test.links).toContainEqual({ url: "https://issue.example/1", name: "issue-1" });

      expect(test.steps).toHaveLength(1);
      const step = test.steps![0]!;
      expect(step.name).toBe("Given the cart has items");
      expect(step.status).toBe("passed");
      expect(step.parameters).toContainEqual({ name: "receipt", value: "rcpt-1" });
      expect(step.parameters).toContainEqual({ name: "mutates (declared)", value: "true" });
      const attachmentNames = step.attachments.map((a) => a.name).sort();
      expect(attachmentNames).toEqual(["declared: note.txt", "http log", "result"]);

      expect(test.attachments!.map((a) => a.name).sort()).toEqual(["shot1.png", "trace"]);
    });

    it("copies the referenced evidence/declared files into resultsDir", () => {
      const results = readResultFiles(resultsDir);
      const test = results.find((r) => (r as { name?: string }).name === "a customer checks out") as {
        steps: { attachments: { name: string; source: string }[] }[];
        attachments: { name: string; source: string }[];
      };
      const declaredAttachment = test.steps[0]!.attachments.find((a) => a.name === "declared: note.txt")!;
      expect(readFileSync(path.join(resultsDir, declaredAttachment.source), "utf8")).toBe("declared note");

      const trace = test.attachments.find((a) => a.name === "trace")!;
      expect(readFileSync(path.join(resultsDir, trace.source), "utf8")).toBe("trace bytes");
    });

    it("writes each hook as its own container, both referencing the test's own uuid in children", () => {
      const containers = readContainerFiles(resultsDir) as {
        children: string[];
        befores: { name: string; status: string }[];
        afters: { name: string; status: string }[];
      }[];

      expect(mappedTestUuid).toBeDefined();
      const beforeContainer = containers.find((c) => c.befores.length > 0)!;
      const afterContainer = containers.find((c) => c.afters.length > 0)!;

      expect(beforeContainer).toBeDefined();
      expect(afterContainer).toBeDefined();
      expect(beforeContainer.children).toContain(mappedTestUuid);
      expect(afterContainer.children).toContain(mappedTestUuid);
      expect(beforeContainer.befores[0]!.status).toBe("passed");
      expect(afterContainer.afters[0]!.status).toBe("passed");
    });
  });

  it("gives two Scenario Outline rows the same testCaseId and different historyId", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const outlineRows = pickles.filter((p) => p.name.startsWith("checkout as"));
    expect(outlineRows).toHaveLength(2);

    for (const [index, pickle] of outlineRows.entries()) {
      const receiptId = `rcpt-outline-${index}`;
      const receipt: Receipt = {
        receipt_id: receiptId,
        step: pickle.steps[0]!.text,
        kind: "run",
        args: {},
        result: null,
        status: "ok",
        environment: "staging",
        session: null,
        scenario: `scn-outline-${index}`,
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:00.500Z",
        evidence: { dir: `.nukadoko/receipts/${receiptId}`, screenshots: [] },
        observed: { http_reads: 0, http_writes: 0 },
        mutates: true,
      };
      writeReceiptFile(rootDir, receipt);

      const record: ScenarioRecord = {
        scenario_id: `scn-outline-${index}`,
        run_id: "run-1",
        feature: "features/checkout.feature",
        scenario: "checkout as <role>",
        line: 7,
        status: "passed",
        environment: "staging",
        session: null,
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:00.500Z",
        steps: [{ text: pickle.steps[0]!.text, status: "passed", receipt: receiptId }],
        hooks: [],
        evidence: { dir: `.nukadoko/scenarios/scn-outline-${index}`, screenshots: [] },
      };

      emitter.emitScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });
    }

    const results = readResultFiles(resultsDir) as { name: string; testCaseId: string; historyId: string }[];
    const rowResults = results.filter((r) => r.name.startsWith("checkout as"));
    expect(rowResults).toHaveLength(2);
    expect(rowResults[0]!.testCaseId).toBe(rowResults[1]!.testCaseId);
    expect(rowResults[0]!.historyId).not.toBe(rowResults[1]!.historyId);
  });

  it("never deletes files from a previous emit into the same resultsDir", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles[0]!;
    const record: ScenarioRecord = {
      scenario_id: "scn-first",
      run_id: "run-1",
      feature: "features/checkout.feature",
      scenario: "a customer checks out",
      line: 3,
      status: "passed",
      environment: "staging",
      session: null,
      started_at: "2026-08-01T00:00:00.000Z",
      finished_at: "2026-08-01T00:00:00.000Z",
      steps: [{ text: "the cart has items", status: "skipped", receipt: null }],
      hooks: [],
      evidence: { dir: ".nukadoko/scenarios/scn-first", screenshots: [] },
    };
    emitter.emitScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });
    const firstRunFiles = new Set(readdirSync(resultsDir));
    expect(firstRunFiles.size).toBeGreaterThan(0);

    // A second emitter, same resultsDir (the same shape a second `nuka run`
    // pointed at the same state directory would produce) — begin() must not
    // clear anything either.
    const secondEmitter = createAllureEmitter({
      resultsDir,
      rootDir,
      environment: "staging",
      secrets: [],
      stderr: createCaptureSink(),
    });
    secondEmitter.begin();
    secondEmitter.emitScenario({
      record: { ...record, scenario_id: "scn-second" },
      gherkinDocument,
      pickle,
      relativeFeaturePath: "features/checkout.feature",
    });

    const afterSecondRun = new Set(readdirSync(resultsDir));
    for (const name of firstRunFiles) {
      expect(afterSecondRun.has(name)).toBe(true);
    }
    expect(afterSecondRun.size).toBeGreaterThan(firstRunFiles.size);
  });

  describe("test.statusDetails.message (M3-C spec item 1)", () => {
    function readTestResult(name: string): { statusDetails?: { message?: string }; status?: string } {
      const results = readResultFiles(resultsDir) as { name?: string; statusDetails?: { message?: string }; status?: string }[];
      const match = results.find((r) => r.name === name);
      expect(match).toBeDefined();
      return match!;
    }

    it("sets statusDetails.message, marked with [nukadoko.failure=<kind>], for a failed scenario", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const receipt: Receipt = {
        receipt_id: "rcpt-fail-1",
        step: "the cart has items",
        kind: "run",
        args: {},
        status: "failed",
        environment: "staging",
        session: null,
        scenario: "scn-fail-1",
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:00.500Z",
        evidence: { dir: ".nukadoko/receipts/rcpt-fail-1", screenshots: [] },
        observed: { http_reads: 0, http_writes: 0 },
        mutates: true,
        error: { message: "it broke on purpose", kind: "step_error" },
      };
      writeReceiptFile(rootDir, receipt);
      const record: ScenarioRecord = {
        scenario_id: "scn-fail-1",
        run_id: "run-1",
        feature: "features/checkout.feature",
        scenario: "a customer checks out",
        line: 3,
        status: "failed",
        environment: "staging",
        session: null,
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:00.500Z",
        steps: [{ text: "the cart has items", status: "failed", receipt: "rcpt-fail-1" }],
        hooks: [],
        evidence: { dir: ".nukadoko/scenarios/scn-fail-1", screenshots: [] },
      };

      emitter.emitScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

      const test = readTestResult("a customer checks out");
      expect(test.status).toBe("failed");
      expect(test.statusDetails?.message).toBe("[nukadoko.failure=step_error] it broke on purpose");
    });

    it("leaves statusDetails unset for a passed scenario", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const record: ScenarioRecord = {
        scenario_id: "scn-pass-1",
        run_id: "run-1",
        feature: "features/checkout.feature",
        scenario: "a customer checks out",
        line: 3,
        status: "passed",
        environment: "staging",
        session: null,
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:00.500Z",
        steps: [{ text: "the cart has items", status: "passed", receipt: null }],
        hooks: [],
        evidence: { dir: ".nukadoko/scenarios/scn-pass-1", screenshots: [] },
      };

      emitter.emitScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

      const test = readTestResult("a customer checks out");
      expect(test.status).toBe("passed");
      expect(test.statusDetails?.message).toBeUndefined();
    });

    it("sets statusDetails.message from a before hook's own failure when it is the first failure", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const beforeHook: ScenarioHookRecord = {
        type: "before",
        status: "failed",
        error: { message: "hook blew up", kind: "step_error" },
      };
      const record: ScenarioRecord = {
        scenario_id: "scn-hook-fail-1",
        run_id: "run-1",
        feature: "features/checkout.feature",
        scenario: "a customer checks out",
        line: 3,
        status: "failed",
        environment: "staging",
        session: null,
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:00.500Z",
        steps: [{ text: "the cart has items", status: "skipped", receipt: null }],
        hooks: [beforeHook],
        evidence: { dir: ".nukadoko/scenarios/scn-hook-fail-1", screenshots: [] },
      };

      emitter.emitScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

      const test = readTestResult("a customer checks out");
      expect(test.statusDetails?.message).toBe("[nukadoko.failure=step_error] hook blew up");
    });

    it("sets statusDetails.message to the plain (unmarked) message when the first failure has no resolvable kind", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const record: ScenarioRecord = {
        scenario_id: "scn-unresolved-1",
        run_id: "run-1",
        feature: "features/checkout.feature",
        scenario: "a customer checks out",
        line: 3,
        status: "failed",
        environment: "staging",
        session: null,
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:00.500Z",
        steps: [
          {
            text: "the cart has items",
            status: "undefined",
            receipt: null,
            error: { message: "no matching step definition" },
          },
        ],
        hooks: [],
        evidence: { dir: ".nukadoko/scenarios/scn-unresolved-1", screenshots: [] },
      };

      emitter.emitScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

      const test = readTestResult("a customer checks out");
      expect(test.statusDetails?.message).toBe("no matching step definition");
      expect((test as { labels?: { name: string }[] }).labels?.some((l) => l.name === "nukadoko.failure")).toBe(
        false,
      );
    });
  });

  describe("failure isolation", () => {
    it("degrades gracefully (no throw, a normal result file) when a step's receipt.json simply doesn't exist", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const record: ScenarioRecord = {
        scenario_id: "scn-missing-receipt",
        run_id: "run-1",
        feature: "features/checkout.feature",
        scenario: "a customer checks out",
        line: 3,
        status: "failed",
        environment: "staging",
        session: null,
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:00.500Z",
        steps: [
          {
            text: "the cart has items",
            status: "failed",
            receipt: "rcpt-never-written",
            error: { message: "refused before it ever ran" },
          },
        ],
        hooks: [],
        evidence: { dir: ".nukadoko/scenarios/scn-missing-receipt", screenshots: [] },
      };

      expect(() =>
        emitter.emitScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" }),
      ).not.toThrow();

      const results = readResultFiles(resultsDir);
      expect(results.some((r) => (r as { name?: string }).name === "a customer checks out")).toBe(true);
    });

    it("catches a genuine internal failure (a receipt claims an evidence file that isn't actually there), warns once to stderr, and leaves other scenarios' output intact", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;

      // A healthy scenario, emitted first, to prove its own output survives
      // a later scenario's failure.
      const healthyRecord: ScenarioRecord = {
        scenario_id: "scn-healthy",
        run_id: "run-1",
        feature: "features/checkout.feature",
        scenario: "a customer checks out",
        line: 3,
        status: "passed",
        environment: "staging",
        session: null,
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:00.500Z",
        steps: [{ text: "the cart has items", status: "skipped", receipt: null }],
        hooks: [],
        evidence: { dir: ".nukadoko/scenarios/scn-healthy", screenshots: [] },
      };
      emitter.emitScenario({
        record: healthyRecord,
        gherkinDocument,
        pickle,
        relativeFeaturePath: "features/checkout.feature",
      });
      const healthyFiles = new Set(readdirSync(resultsDir));

      // A receipt whose own evidence.http names a file that was never
      // actually written — writeAttachmentFromPath's copyFileSync throws
      // ENOENT for it, a genuine internal failure this task's spec, decision
      // 11 says must never escape emitScenario.
      const receipt: Receipt = {
        receipt_id: "rcpt-broken",
        step: "the cart has items",
        kind: "run",
        args: {},
        result: null,
        status: "ok",
        environment: "staging",
        session: null,
        scenario: "scn-broken",
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:00.500Z",
        evidence: { dir: ".nukadoko/receipts/rcpt-broken", screenshots: [], http: "http.jsonl" },
        observed: { http_reads: 0, http_writes: 0 },
        mutates: true,
      };
      writeReceiptFile(rootDir, receipt);
      // Deliberately not writing .nukadoko/receipts/rcpt-broken/http.jsonl.

      const brokenRecord: ScenarioRecord = {
        scenario_id: "scn-broken",
        run_id: "run-1",
        feature: "features/checkout.feature",
        scenario: "a customer checks out",
        line: 3,
        status: "passed",
        environment: "staging",
        session: null,
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:00.500Z",
        steps: [{ text: "the cart has items", status: "passed", receipt: "rcpt-broken" }],
        hooks: [],
        evidence: { dir: ".nukadoko/scenarios/scn-broken", screenshots: [] },
      };

      expect(() =>
        emitter.emitScenario({
          record: brokenRecord,
          gherkinDocument,
          pickle,
          relativeFeaturePath: "features/checkout.feature",
        }),
      ).not.toThrow();

      expect(sink.text()).toContain("warning:");
      expect(sink.text()).toContain("scn-broken");

      const afterFiles = new Set(readdirSync(resultsDir));
      for (const name of healthyFiles) {
        expect(afterFiles.has(name)).toBe(true);
      }
    });
  });
});

describe("createAllureEmitter: begin() failure isolation", () => {
  it("warns to stderr instead of throwing when categories.json can't be written", () => {
    // A deterministic, environment-independent way to make begin()'s own
    // write fail: pre-create resultsDir with a *directory* already sitting
    // at the exact path categories.json would be written to. writer.ts's
    // own atomic write always renames a temp file onto that exact final
    // name, and renaming a file onto an existing directory always fails
    // (EISDIR), regardless of platform/CI permissions setup.
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-allure-begin-"));
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: "acme-checkout" }));
    const resultsDir = path.join(rootDir, ".nukadoko", "allure-results");
    mkdirSync(path.join(resultsDir, "categories.json"), { recursive: true });
    const sink = createCaptureSink();

    const emitter = createAllureEmitter({
      resultsDir,
      rootDir,
      environment: "staging",
      secrets: [],
      stderr: sink,
    });

    try {
      expect(() => emitter.begin()).not.toThrow();
      expect(sink.text()).toContain("warning:");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
