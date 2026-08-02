import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Envelope } from "@cucumber/messages";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFeatureSource } from "../src/feature/load-features.js";
import { createMessagesEmitter, type MessagesEmitter } from "../src/report/messages/emitter.js";
import type { Receipt } from "../src/receipt/types.js";
import type { ScenarioHookRecord, ScenarioRecord, ScenarioStepRecord } from "../src/run/record-types.js";
import { createCaptureSink } from "./helpers/fixtures.js";

// Responsibility: integration tests (this task's spec, test item 2) —
// drives the real `createMessagesEmitter` end to end against fixture
// record.json/receipt.json data (built here as plain objects, not by
// actually running a scenario) and reads the real NDJSON file it writes
// back off disk, one `JSON.parse` per line. No `.feature` file on disk is
// needed: `parseFeatureSource` takes source text directly.

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

function readEnvelopes(output: string): Envelope[] {
  const content = readFileSync(output, "utf8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Envelope);
}

describe("createMessagesEmitter", () => {
  let rootDir: string;
  let output: string;
  let sink: { write(chunk: string): boolean; text(): string };
  let emitter: MessagesEmitter;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-messages-emitter-"));
    output = path.join(rootDir, ".nukadoko", "report", "messages.ndjson");
    sink = createCaptureSink();
    emitter = createMessagesEmitter({ output, rootDir, stderr: sink });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  describe("a full run: begin -> emitScenario x2 -> end(true)", () => {
    let envelopes: Envelope[];

    beforeEach(() => {
      const featurePath = path.join(rootDir, "features", "checkout.feature");
      mkdirSync(path.dirname(featurePath), { recursive: true });
      writeFileSync(featurePath, FEATURE_SOURCE);

      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const outlineRow = pickles.find((p) => p.name.startsWith("checkout as"))!;

      emitter.begin({ relativeFeaturePath: "features/checkout.feature", gherkinDocument, pickles });

      const receiptDir = path.join(rootDir, ".nukadoko", "receipts", "rcpt-1");
      mkdirSync(receiptDir, { recursive: true });
      writeFileSync(path.join(receiptDir, "note.txt"), "declared note");

      const receipt: Receipt = {
        receipt_id: "rcpt-1",
        step: "the cart has items",
        kind: "run",
        args: {},
        result: { ok: true },
        status: "ok",
        environment: "staging",
        session: null,
        scenario: "scn-1",
        started_at: "2026-08-01T00:00:00.500Z",
        finished_at: "2026-08-01T00:00:01.000Z",
        evidence: { dir: ".nukadoko/receipts/rcpt-1", screenshots: [], http: "http.jsonl" },
        observed: { http_reads: 1, http_writes: 0 },
        mutates: true,
        declared: { attachments: ["note.txt"], logs: ["did the thing"] },
      };
      writeReceiptFile(rootDir, receipt);

      const scenarioDir = path.join(rootDir, ".nukadoko", "scenarios", "scn-1");
      mkdirSync(scenarioDir, { recursive: true });
      writeFileSync(path.join(scenarioDir, "trace.zip"), "trace bytes");
      writeFileSync(path.join(scenarioDir, "shot1.png"), "png bytes");

      const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", receipt: "rcpt-1" };
      const beforeHook: ScenarioHookRecord = { type: "before", status: "ok" };
      const afterHook: ScenarioHookRecord = { type: "after", status: "ok" };
      const record: ScenarioRecord = {
        scenario_id: "scn-1",
        feature: "features/checkout.feature",
        scenario: "a customer checks out",
        line: 3,
        status: "passed",
        environment: "staging",
        session: null,
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:02.000Z",
        steps: [step],
        hooks: [beforeHook, afterHook],
        evidence: { dir: ".nukadoko/scenarios/scn-1", trace: "trace.zip", screenshots: ["shot1.png"] },
      };
      emitter.emitScenario({ record, pickle });

      const record2: ScenarioRecord = {
        scenario_id: "scn-2",
        feature: "features/checkout.feature",
        scenario: "checkout as <role>",
        line: 7,
        status: "passed",
        environment: "staging",
        session: null,
        started_at: "2026-08-01T00:00:02.000Z",
        finished_at: "2026-08-01T00:00:02.500Z",
        steps: [{ text: outlineRow.steps[0]!.text, status: "passed", receipt: null }],
        hooks: [],
        evidence: { dir: ".nukadoko/scenarios/scn-2", screenshots: [] },
      };
      emitter.emitScenario({ record: record2, pickle: outlineRow });

      emitter.end(true);

      envelopes = readEnvelopes(output);
    });

    it("produces valid NDJSON, one JSON.parse-able envelope per line", () => {
      expect(envelopes.length).toBeGreaterThan(0);
    });

    it("orders envelopes: meta, source, gherkinDocument, pickle x N, testRunStarted, then per-scenario blocks, then testRunFinished", () => {
      const kinds = envelopes.map((e) => Object.keys(e)[0]);
      expect(kinds[0]).toBe("meta");
      expect(kinds[1]).toBe("source");
      expect(kinds[2]).toBe("gherkinDocument");
      // 3 pickles total in this feature (1 + 2 outline rows).
      expect(kinds.slice(3, 6)).toEqual(["pickle", "pickle", "pickle"]);
      expect(kinds[6]).toBe("testRunStarted");
      expect(kinds.at(-1)).toBe("testRunFinished");

      // Scenario 1's own block: hook(before), hook(after) [first appearance
      // of each type], testCase, testCaseStarted, testStepStarted,
      // attachment x N, testStepFinished, ..., testCaseFinished.
      const scenario1Start = 7;
      expect(kinds[scenario1Start]).toBe("hook");
      expect(kinds[scenario1Start + 1]).toBe("hook");
      expect(kinds[scenario1Start + 2]).toBe("testCase");
      expect(kinds[scenario1Start + 3]).toBe("testCaseStarted");
    });

    it("makes source.uri, gherkinDocument.uri, and every pickle.uri the identical string", () => {
      const source = envelopes.find((e) => e.source)!.source!;
      const gherkinDocument = envelopes.find((e) => e.gherkinDocument)!.gherkinDocument!;
      const pickleEnvelopes = envelopes.filter((e) => e.pickle).map((e) => e.pickle!);

      expect(gherkinDocument.uri).toBe(source.uri);
      for (const pickle of pickleEnvelopes) {
        expect(pickle.uri).toBe(source.uri);
      }
    });

    it("gives source.data the feature file's own original text", () => {
      const source = envelopes.find((e) => e.source)!.source!;
      expect(source.data).toBe(FEATURE_SOURCE);
    });

    it("referential integrity: testCaseStarted/testStepFinished/testCase/attachment all resolve to envelopes already in the stream", () => {
      const testCaseIds = new Set(envelopes.filter((e) => e.testCase).map((e) => e.testCase!.id));
      const pickleIds = new Set(envelopes.filter((e) => e.pickle).map((e) => e.pickle!.id));

      const testCaseStartedById = new Map(
        envelopes.filter((e) => e.testCaseStarted).map((e) => [e.testCaseStarted!.id, e.testCaseStarted!]),
      );
      const testStepsByTestCaseId = new Map(
        envelopes.filter((e) => e.testCase).map((e) => [e.testCase!.id, new Set(e.testCase!.testSteps.map((s) => s.id))]),
      );
      const testCaseIdByStartedId = new Map(
        [...testCaseStartedById.entries()].map(([startedId, started]) => [startedId, started.testCaseId]),
      );

      for (const started of testCaseStartedById.values()) {
        expect(testCaseIds.has(started.testCaseId)).toBe(true);
      }
      for (const envelope of envelopes) {
        if (envelope.testCase) {
          expect(pickleIds.has(envelope.testCase.pickleId)).toBe(true);
        }
        if (envelope.testStepFinished) {
          const testCaseId = testCaseIdByStartedId.get(envelope.testStepFinished.testCaseStartedId)!;
          expect(testStepsByTestCaseId.get(testCaseId)!.has(envelope.testStepFinished.testStepId)).toBe(true);
        }
        if (envelope.attachment) {
          expect(testCaseStartedById.has(envelope.attachment.testCaseStartedId!)).toBe(true);
          const testCaseId = testCaseIdByStartedId.get(envelope.attachment.testCaseStartedId!)!;
          expect(testStepsByTestCaseId.get(testCaseId)!.has(envelope.attachment.testStepId!)).toBe(true);
        }
      }
    });

    it("loads the declared file attachment as base64 and the declared log as text/x.cucumber.log+plain, and never emits trace/screenshot/http.jsonl", () => {
      const attachments = envelopes.filter((e) => e.attachment).map((e) => e.attachment!);

      const fileAttachment = attachments.find((a) => a.fileName === "note.txt")!;
      expect(fileAttachment).toBeDefined();
      expect(fileAttachment.contentEncoding).toBe("BASE64");
      expect(Buffer.from(fileAttachment.body, "base64").toString("utf8")).toBe("declared note");

      const logAttachment = attachments.find((a) => a.mediaType === "text/x.cucumber.log+plain")!;
      expect(logAttachment).toBeDefined();
      expect(logAttachment.contentEncoding).toBe("IDENTITY");
      expect(logAttachment.body).toBe("did the thing");
      expect(logAttachment.fileName).toBeUndefined();

      expect(attachments.some((a) => a.fileName === "trace.zip")).toBe(false);
      expect(attachments.some((a) => a.fileName === "shot1.png")).toBe(false);
      expect(attachments.some((a) => a.fileName === "http.jsonl")).toBe(false);
      expect(attachments).toHaveLength(2);
    });

    it("sets testRunFinished.success to true", () => {
      const testRunFinished = envelopes.find((e) => e.testRunFinished)!.testRunFinished!;
      expect(testRunFinished.success).toBe(true);
    });

    it("only two Hook envelopes total, even across two scenarios", () => {
      const hooks = envelopes.filter((e) => e.hook);
      expect(hooks).toHaveLength(2);
    });
  });

  it("truncates output on begin(), so a previous run's lines never survive", () => {
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, "leftover line from a previous run\n");

    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    emitter.begin({ relativeFeaturePath: "features/checkout.feature", gherkinDocument, pickles });

    const content = readFileSync(output, "utf8");
    expect(content).not.toContain("leftover line from a previous run");
  });

  it("degrades gracefully when a declared attachment file doesn't exist: warns, but the scenario's own envelopes still land", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles[0]!;
    emitter.begin({ relativeFeaturePath: "features/checkout.feature", gherkinDocument, pickles });

    const receipt: Receipt = {
      receipt_id: "rcpt-missing-file",
      step: "the cart has items",
      kind: "run",
      args: {},
      result: null,
      status: "ok",
      environment: "staging",
      session: null,
      scenario: "scn-missing-file",
      started_at: "2026-08-01T00:00:00.000Z",
      finished_at: "2026-08-01T00:00:00.500Z",
      evidence: { dir: ".nukadoko/receipts/rcpt-missing-file", screenshots: [] },
      observed: { http_reads: 0, http_writes: 0 },
      mutates: true,
      declared: { attachments: ["never-written.txt"] },
    };
    writeReceiptFile(rootDir, receipt);

    const record: ScenarioRecord = {
      scenario_id: "scn-missing-file",
      feature: "features/checkout.feature",
      scenario: "a customer checks out",
      line: 3,
      status: "passed",
      environment: "staging",
      session: null,
      started_at: "2026-08-01T00:00:00.000Z",
      finished_at: "2026-08-01T00:00:00.500Z",
      steps: [{ text: "the cart has items", status: "passed", receipt: "rcpt-missing-file" }],
      hooks: [],
      evidence: { dir: ".nukadoko/scenarios/scn-missing-file", screenshots: [] },
    };

    expect(() => emitter.emitScenario({ record, pickle })).not.toThrow();

    expect(sink.text()).toContain("warning:");
    expect(sink.text()).toContain("never-written.txt");

    const envelopes = readEnvelopes(output);
    expect(envelopes.some((e) => e.testCase)).toBe(true);
    expect(envelopes.some((e) => e.attachment)).toBe(false);
  });

  it("sets testRunFinished.success to false on end(false)", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    emitter.begin({ relativeFeaturePath: "features/checkout.feature", gherkinDocument, pickles });
    emitter.end(false);

    const envelopes = readEnvelopes(output);
    const testRunFinished = envelopes.find((e) => e.testRunFinished)!.testRunFinished!;
    expect(testRunFinished.success).toBe(false);
  });

  describe("begin() failure isolation", () => {
    it("degrades to a silent no-op for emitScenario/end when begin() itself fails (unwritable output path)", () => {
      // A deterministic way to make begin()'s own truncate fail: pre-create
      // a *directory* at the exact path `output` would be written to —
      // `writeFileSync` onto an existing directory always fails (EISDIR),
      // regardless of platform/CI permissions setup.
      mkdirSync(output, { recursive: true });

      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;

      expect(() => emitter.begin({ relativeFeaturePath: "features/checkout.feature", gherkinDocument, pickles })).not.toThrow();
      expect(sink.text()).toContain("warning:");

      const record: ScenarioRecord = {
        scenario_id: "scn-1",
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
        evidence: { dir: ".nukadoko/scenarios/scn-1", screenshots: [] },
      };

      expect(() => emitter.emitScenario({ record, pickle })).not.toThrow();
      expect(() => emitter.end(true)).not.toThrow();
    });
  });
});
