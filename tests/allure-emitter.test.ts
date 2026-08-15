import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFeatureSource } from "../src/feature/load-features.js";
import { createAllureEmitter, type AllureEmitter, type EmitStepInput } from "../src/report/allure/emitter.js";
import type { StepRecord } from "../src/record/types.js";
import type { ScenarioHookRecord, ScenarioRecord, ScenarioStepRecord } from "../src/run/record-types.js";
import { createCaptureSink } from "./helpers/fixtures.js";

// Responsibility: integration tests — drives the real allure-js-commons
// ReporterRuntime end to end against fixture record.json/step record.json data
// (built here as plain objects, not by actually running a scenario) and
// reads the real files it writes back off disk. No `.feature` file on disk
// is needed either: `parseFeatureSource` takes source text directly.
//
// Rewritten around the new three-call shape
// (`beginScenario`/`emitStep`/`endScenario` replacing the old single
// `emitScenario`) — step = test now (decision 1), so most assertions that
// used to read "the one scenario test" now read one of possibly several
// step tests instead.

const FEATURE_SOURCE = `Feature: Checkout
  Handles the checkout flow.

  Scenario: a customer checks out
    Given the cart has items
    Then the total is correct

  Scenario Outline: checkout as <role>
    Given a <role> customer

    Examples:
      | role   |
      | guest  |
      | member |
`;

function writeStepRecordFile(rootDir: string, stepRecord: StepRecord): void {
  const dir = path.join(rootDir, ".nukadoko", "records", "steps", stepRecord.record_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "record.json"), `${JSON.stringify(stepRecord, null, 2)}\n`);
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

/** A minimal, valid `EmitStepInput` — every test below overrides only the
 * fields it actually cares about, the same "one baseline, spread + override"
 * convention the old `record`/`stepRecord` object literals already followed. */
function baseStepInput(overrides: Partial<EmitStepInput> & Pick<EmitStepInput, "record" | "stepRecord">): EmitStepInput {
  return {
    runId: "run-1",
    scenarioId: "scn-1",
    environment: "staging",
    session: null,
    index: 0,
    finishedAt: new Date("2026-08-01T00:00:01.000Z"),
    gherkinDocument: overrides.gherkinDocument!,
    pickle: overrides.pickle!,
    relativeFeaturePath: "features/checkout.feature",
    ...overrides,
  };
}

describe("createAllureEmitter", () => {
  let rootDir: string;
  let resultsDir: string;
  let sink: { write(chunk: string): boolean; text(): string };
  let emitter: AllureEmitter;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-allure-emitter-"));
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: "acme-checkout" }));
    resultsDir = path.join(rootDir, ".nukadoko", "export", "allure-results");
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

  describe("a full scenario with two steps and before/after hooks", () => {
    let step1Uuid: string | undefined;
    let step2Uuid: string | undefined;

    beforeEach(() => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;

      const recordDir = path.join(rootDir, ".nukadoko", "records", "steps", "step-1");
      mkdirSync(recordDir, { recursive: true });
      writeFileSync(path.join(recordDir, "note.txt"), "declared note");
      writeFileSync(path.join(recordDir, "http.jsonl"), '{"method":"GET","url":"https://x","status":200,"duration_ms":5}\n');

      const stepRecord1: StepRecord = {
        record_id: "step-1",
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
        evidence: { dir: ".nukadoko/records/steps/step-1", screenshots: [], http: "http.jsonl", trace: "step-trace.zip" },
        observed: { http_reads: 1, http_writes: 0 },
        mutates: true,
        declared: {
          attachments: ["note.txt"],
          links: [{ url: "https://issue.example/1", name: "issue-1" }],
          logs: ["did the thing"],
        },
      };
      writeStepRecordFile(rootDir, stepRecord1);
      writeFileSync(path.join(rootDir, ".nukadoko", "records", "steps", "step-1", "step-trace.zip"), "step trace bytes");

      const stepRecord2: StepRecord = {
        record_id: "step-2",
        step: "the total is correct",
        kind: "run",
        args: {},
        result: null,
        status: "ok",
        environment: "staging",
        session: "sess-1",
        scenario: "scn-1",
        started_at: "2026-08-01T00:00:01.000Z",
        finished_at: "2026-08-01T00:00:01.200Z",
        evidence: { dir: ".nukadoko/records/steps/step-2", screenshots: [] },
        observed: { http_reads: 0, http_writes: 0 },
        mutates: false,
      };
      writeStepRecordFile(rootDir, stepRecord2);

      const scenarioDir = path.join(rootDir, ".nukadoko", "records", "scenarios", "scn-1");
      mkdirSync(scenarioDir, { recursive: true });
      writeFileSync(path.join(scenarioDir, "trace.zip"), "trace bytes");
      writeFileSync(path.join(scenarioDir, "shot1.png"), "png bytes");
      writeFileSync(path.join(scenarioDir, "hook-note.txt"), "hook declared note");

      const step1: ScenarioStepRecord = { text: "the cart has items", status: "passed", record: "step-1" };
      const step2: ScenarioStepRecord = { text: "the total is correct", status: "passed", record: "step-2" };
      const beforeHook: ScenarioHookRecord = {
        type: "before",
        status: "ok",
        declared: { attachments: ["hook-note.txt"], logs: ["hook did something"], parameters: [{ name: "hook-param", value: "y" }] },
      };
      const afterHook: ScenarioHookRecord = { type: "after", status: "ok" };

      emitter.beginScenario();
      emitter.emitStep(
        baseStepInput({
          record: step1,
          stepRecord: stepRecord1,
          index: 0,
          gherkinDocument,
          pickle,
          session: "sess-1",
          targetVersion: "9.9.9",
        }),
      );
      emitter.emitStep(
        baseStepInput({
          record: step2,
          stepRecord: stepRecord2,
          index: 1,
          gherkinDocument,
          pickle,
          session: "sess-1",
          targetVersion: "9.9.9",
        }),
      );

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
        finished_at: "2026-08-01T00:00:01.200Z",
        steps: [step1, step2],
        hooks: [beforeHook, afterHook],
        evidence: {
          dir: ".nukadoko/records/scenarios/scn-1",
          trace: "trace.zip",
          screenshots: [{ file: "shot1.png", at: "2026-08-01T00:00:01.150Z" }],
        },
      };
      emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

      const results = readResultFiles(resultsDir);
      step1Uuid = (results.find((r) => (r as { name?: string }).name === "Given the cart has items") as { uuid?: string } | undefined)?.uuid;
      step2Uuid = (results.find((r) => (r as { name?: string }).name === "Then the total is correct") as { uuid?: string } | undefined)?.uuid;
    });

    it("writes one result.json per step (step count = test count), not one per scenario", () => {
      const results = readResultFiles(resultsDir);
      const names = results.map((r) => (r as { name?: string }).name).filter((name) => name !== undefined);
      expect(names).toContain("Given the cart has items");
      expect(names).toContain("Then the total is correct");
      // Exactly the two steps this scenario has — no third "scenario" test
      // exists any more.
      expect(names.filter((name) => name?.includes("cart") || name?.includes("total"))).toHaveLength(2);
    });

    it("fills parentSuite from the feature and suite from the scenario on every step's own test", () => {
      const results = readResultFiles(resultsDir);
      const step1 = results.find((r) => (r as { name?: string }).name === "Given the cart has items") as {
        labels?: { name: string; value: string }[];
      };
      expect(step1.labels).toContainEqual({ name: "parentSuite", value: "Checkout" });
      expect(step1.labels).toContainEqual({ name: "suite", value: "a customer checks out" });
    });

    it("writes step1's own labels/parameters/attachments/links, kept off step2's own test", () => {
      const results = readResultFiles(resultsDir);
      const step1 = results.find((r) => (r as { name?: string }).name === "Given the cart has items") as {
        fullName?: string;
        status?: string;
        labels?: { name: string; value: string }[];
        parameters?: { name: string; value: string; excluded?: boolean; mode?: string }[];
        steps?: { name: string; status: string }[];
        attachments?: { name: string; type: string }[];
        links?: { url: string; name?: string }[];
      };
      const step2 = results.find((r) => (r as { name?: string }).name === "Then the total is correct") as {
        links?: { url: string; name?: string }[];
        attachments?: { name: string }[];
      };

      expect(step1).toBeDefined();
      expect(step1.fullName).toBe("acme-checkout:features/checkout.feature#a customer checks out#Given the cart has items");
      expect(step1.status).toBe("passed");

      expect(step1.labels).toContainEqual({ name: "feature", value: "Checkout" });
      expect(step1.labels).toContainEqual({ name: "package", value: "features.checkout.feature" });
      expect(step1.labels).toContainEqual({ name: "env", value: "staging" });

      expect(step1.parameters).toContainEqual({ name: "environment", value: "staging", excluded: true });
      expect(step1.parameters).toContainEqual({ name: "session", value: "sess-1", excluded: true });
      expect(step1.parameters).toContainEqual({ name: "target_version", value: "9.9.9", excluded: true });
      expect(step1.parameters).toContainEqual({ name: "record", value: "step-1" });
      expect(step1.parameters).toContainEqual({ name: "mutates (declared)", value: "true" });

      expect(step1.links).toContainEqual({ url: "https://issue.example/1", name: "issue-1" });
      // step1's own declared link never leaks onto step2's own test —
      // declared data is step-scoped now, not
      // aggregated across the whole scenario the way it used to be.
      expect(step2.links ?? []).not.toContainEqual(expect.objectContaining({ url: "https://issue.example/1" }));

      const attachmentNames = step1.attachments!.map((a) => a.name).sort();
      expect(attachmentNames).toEqual(["declared: note.txt", "http log", "record.json", "result", "trace"]);
      const traceAttachment = step1.attachments!.find((a) => a.name === "trace") as { type: string; source?: string };
      expect(traceAttachment.type).toBe("application/vnd.allure.playwright-trace");
      // Step1's own trace never leaks onto step2's own test — a step's own
      // step record evidence.trace attaches to
      // that step's own test only.
      expect(step2.attachments!.map((a) => a.name)).not.toContain("trace");
      // Neither step carries the *scenario's* own trace/screenshot — those
      // land on a dedicated fixture instead (`mapScenarioEvidence`, below).
      expect(step2.attachments!.map((a) => a.name)).not.toContain("shot1.png");
      expect(step1.attachments!.filter((a) => a.name === "trace")).toHaveLength(1);
    });

    it("copies a step's own step record evidence.trace into resultsDir, attached to that step's own test", () => {
      const results = readResultFiles(resultsDir);
      const step1 = results.find((r) => (r as { name?: string }).name === "Given the cart has items") as {
        attachments: { name: string; source: string }[];
      };
      const trace = step1.attachments.find((a) => a.name === "trace")!;
      expect(readFileSync(path.join(resultsDir, trace.source), "utf8")).toBe("step trace bytes");
    });

    it("nests a declared log line directly under the step's own test (one level shallower than before)", () => {
      const results = readResultFiles(resultsDir);
      const step1 = results.find((r) => (r as { name?: string }).name === "Given the cart has items") as {
        steps?: { name: string; status: string }[];
      };
      // Directly in `steps`, not nested one level deeper under a per-pickle-
      // step node the way it was when the scenario itself was the test.
      expect(step1.steps).toContainEqual(expect.objectContaining({ name: "did the thing", status: "passed" }));
    });

    it("copies the referenced evidence/declared files into resultsDir", () => {
      const results = readResultFiles(resultsDir);
      const step1 = results.find((r) => (r as { name?: string }).name === "Given the cart has items") as {
        attachments: { name: string; source: string }[];
      };
      const declaredAttachment = step1.attachments.find((a) => a.name === "declared: note.txt")!;
      expect(readFileSync(path.join(resultsDir, declaredAttachment.source), "utf8")).toBe("declared note");
    });

    it("writes each hook as its own container, both referencing every step's own test uuid in children", () => {
      const containers = readContainerFiles(resultsDir) as {
        children: string[];
        befores: { name: string; status: string; parameters?: { name: string; value: string }[] }[];
        afters: { name: string; status: string }[];
      }[];

      expect(step1Uuid).toBeDefined();
      expect(step2Uuid).toBeDefined();
      const beforeContainer = containers.find((c) => c.befores.length > 0)!;
      const afterContainer = containers.find((c) => c.afters.length > 0)!;

      expect(beforeContainer).toBeDefined();
      expect(afterContainer).toBeDefined();
      expect(beforeContainer.children).toContain(step1Uuid);
      expect(beforeContainer.children).toContain(step2Uuid);
      expect(afterContainer.children).toContain(step1Uuid);
      expect(afterContainer.children).toContain(step2Uuid);
      expect(beforeContainer.befores[0]!.status).toBe("passed");
      expect(afterContainer.afters[0]!.status).toBe("passed");
      // A hook's own declared parameter lands on that hook's own fixture
      // (there is no test left to bubble it onto).
      expect(beforeContainer.befores[0]!.parameters).toContainEqual({ name: "hook-param", value: "y" });
    });

    it("writes the scenario's own trace/screenshot as a dedicated 'Scenario evidence' fixture, not folded into any step or real hook", () => {
      const containers = readContainerFiles(resultsDir) as {
        befores: { name: string }[];
        afters: { name: string; attachments: { name: string; type: string; source: string }[] }[];
      }[];
      const evidenceContainer = containers.find((c) => c.afters.some((a) => a.name === "Scenario evidence"));
      expect(evidenceContainer).toBeDefined();
      const fixture = evidenceContainer!.afters.find((a) => a.name === "Scenario evidence")!;
      const names = fixture.attachments.map((a) => a.name).sort();
      expect(names).toEqual(["shot1.png", "trace"]);
      const trace = fixture.attachments.find((a) => a.name === "trace")!;
      expect(readFileSync(path.join(resultsDir, trace.source), "utf8")).toBe("trace bytes");
    });
  });

  it("writes a hook's own trace as a real attachment on its fixture, and its actions as a real child step", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles[0]!;

    const scenarioDir = path.join(rootDir, ".nukadoko", "records", "scenarios", "scn-hook-trace-1");
    mkdirSync(scenarioDir, { recursive: true });
    writeFileSync(path.join(scenarioDir, "hook-before-0.zip"), "hook trace bytes");

    const beforeHook: ScenarioHookRecord = {
      type: "before",
      status: "ok",
      trace: "hook-before-0.zip",
      actions: [
        { method: "goto", url: "data:text/html,before-hook", ms: 5, outcome: "passed", at: "2026-08-01T00:00:00.100Z" },
      ],
    };
    // At least one step, and one `emitStep` call for it, is required for
    // this fixture's own container to be written at all — allure-js-
    // commons' own `ReporterRuntime.writeScope` silently skips every
    // fixture in a scope with zero tests attached (verified against its own
    // `_writeFixturesOfScope`: `if (tests.length) { ... }`), the same as it
    // would for a scenario with zero real pickle steps in practice.
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", record: null };
    const record: ScenarioRecord = {
      scenario_id: "scn-hook-trace-1",
      run_id: "run-1",
      feature: "features/checkout.feature",
      scenario: "a customer checks out",
      line: 3,
      status: "passed",
      environment: "staging",
      session: null,
      started_at: "2026-08-01T00:00:00.000Z",
      finished_at: "2026-08-01T00:00:00.500Z",
      steps: [step],
      hooks: [beforeHook],
      evidence: { dir: ".nukadoko/records/scenarios/scn-hook-trace-1", screenshots: [] },
    };

    emitter.beginScenario();
    emitter.emitStep(baseStepInput({ record: step, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-hook-trace-1" }));
    emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

    const containers = readContainerFiles(resultsDir) as {
      befores: { name: string; status: string; attachments: { name: string; type: string; source: string }[]; steps: { name: string }[] }[];
    }[];
    const beforeContainer = containers.find((c) => c.befores.length > 0)!;
    expect(beforeContainer).toBeDefined();
    const fixture = beforeContainer.befores[0]!;

    const traceAttachment = fixture.attachments.find((a) => a.name === "trace")!;
    expect(traceAttachment).toBeDefined();
    expect(traceAttachment.type).toBe("application/vnd.allure.playwright-trace");
    expect(readFileSync(path.join(resultsDir, traceAttachment.source), "utf8")).toBe("hook trace bytes");

    expect(fixture.steps.map((s) => s.name)).toEqual(["goto data:text/html,before-hook"]);
  });

  describe("identity: no history across runs, scenarios, or steps", () => {
    function emitOnce(input: Partial<EmitStepInput> & Pick<EmitStepInput, "record" | "stepRecord" | "gherkinDocument" | "pickle">): void {
      emitter.beginScenario();
      emitter.emitStep(baseStepInput(input));
    }

    it("gives each Scenario Outline row its own SDK-derived testCaseId (md5 of that row's own fullName)", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const outlineRows = pickles.filter((p) => p.name.startsWith("checkout as"));
      expect(outlineRows).toHaveLength(2);

      for (const [index, pickle] of outlineRows.entries()) {
        const recordId = `step-outline-${index}`;
        const stepRecord: StepRecord = {
          record_id: recordId,
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
          evidence: { dir: `.nukadoko/records/steps/${recordId}`, screenshots: [] },
          observed: { http_reads: 0, http_writes: 0 },
          mutates: true,
        };
        writeStepRecordFile(rootDir, stepRecord);
        const record: ScenarioStepRecord = { text: pickle.steps[0]!.text, status: "passed", record: recordId };
        emitOnce({ record, stepRecord, gherkinDocument, pickle, scenarioId: `scn-outline-${index}` });
      }

      const results = readResultFiles(resultsDir) as { name: string; fullName: string; testCaseId: string }[];
      const rowResults = results.filter((r) => r.name.startsWith("Given a"));
      expect(rowResults).toHaveLength(2);
      // No `templateName`/explicit `testCaseId` computation any more (the
      // old "share one testCaseId across every
      // row" design existed to serve history/trend continuity, which this
      // task deliberately withdraws) — each row's own pickle-substituted
      // step text ("a guest customer" vs "a member customer") already makes
      // its own `fullName` distinct, so `ReporterRuntime.stopTest`'s own
      // fallback (`md5(fullName)`, allure-js-commons' own
      // `getTestResultTestCaseId`) gives the two rows two different
      // testCaseIds, verified here bit for bit rather than assumed.
      for (const row of rowResults) {
        expect(row.testCaseId).toBe(createHash("md5").update(row.fullName).digest("hex"));
      }
      expect(rowResults[0]!.testCaseId).not.toBe(rowResults[1]!.testCaseId);
    });

    it("gives two emits of the exact same step a different historyId when runId differs", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const record: ScenarioStepRecord = { text: "the cart has items", status: "passed", record: null };

      emitOnce({ record, stepRecord: null, gherkinDocument, pickle, runId: "run-A", scenarioId: "scn-x", index: 0 });
      emitOnce({ record, stepRecord: null, gherkinDocument, pickle, runId: "run-B", scenarioId: "scn-x", index: 0 });

      const results = readResultFiles(resultsDir) as { historyId: string }[];
      expect(results).toHaveLength(2);
      expect(results[0]!.historyId).not.toBe(results[1]!.historyId);
    });

    it("gives two emits of the exact same step a different historyId when scenarioId differs (two scenarios sharing one run)", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const record: ScenarioStepRecord = { text: "the cart has items", status: "passed", record: null };

      emitOnce({ record, stepRecord: null, gherkinDocument, pickle, runId: "run-A", scenarioId: "scn-1", index: 0 });
      emitOnce({ record, stepRecord: null, gherkinDocument, pickle, runId: "run-A", scenarioId: "scn-2", index: 0 });

      const results = readResultFiles(resultsDir) as { historyId: string }[];
      expect(results).toHaveLength(2);
      expect(results[0]!.historyId).not.toBe(results[1]!.historyId);
    });

    it("gives two steps sharing the exact same text in one scenario a different historyId (index differs)", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const record: ScenarioStepRecord = { text: "the cart has items", status: "passed", record: null };

      emitOnce({ record, stepRecord: null, gherkinDocument, pickle, runId: "run-A", scenarioId: "scn-1", index: 0 });
      emitOnce({ record, stepRecord: null, gherkinDocument, pickle, runId: "run-A", scenarioId: "scn-1", index: 1 });

      const results = readResultFiles(resultsDir) as { historyId: string }[];
      expect(results).toHaveLength(2);
      expect(results[0]!.historyId).not.toBe(results[1]!.historyId);
    });

    it("marks the identity parameters mode: hidden (visible in the file, but excluded: false) rather than excluded: true", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const record: ScenarioStepRecord = { text: "the cart has items", status: "passed", record: null };
      emitOnce({ record, stepRecord: null, gherkinDocument, pickle, runId: "run-A", scenarioId: "scn-1", index: 0 });

      const results = readResultFiles(resultsDir) as {
        parameters: { name: string; value: string; excluded?: boolean; mode?: string }[];
      }[];
      const runParam = results[0]!.parameters.find((p) => p.name === "nukadoko.run")!;
      expect(runParam).toBeDefined();
      expect(runParam.mode).toBe("hidden");
      expect(runParam.excluded).toBeFalsy();
      expect(results[0]!.parameters.find((p) => p.name === "nukadoko.scenario")?.mode).toBe("hidden");
      expect(results[0]!.parameters.find((p) => p.name === "nukadoko.step")?.mode).toBe("hidden");
    });
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
      steps: [{ text: "the cart has items", status: "skipped", record: null }],
      hooks: [],
      evidence: { dir: ".nukadoko/records/scenarios/scn-first", screenshots: [] },
    };
    emitter.beginScenario();
    emitter.emitStep(baseStepInput({ record: record.steps[0]!, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-first" }));
    emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });
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
    secondEmitter.beginScenario();
    secondEmitter.emitStep(
      baseStepInput({ record: record.steps[0]!, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-second" }),
    );
    secondEmitter.endScenario({
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

  describe("statusDetails.message (M3-C spec item 1, retargeted to a step's own test)", () => {
    function readStepResult(name: string): { statusDetails?: { message?: string }; status?: string; labels?: { name: string }[] } {
      const results = readResultFiles(resultsDir) as {
        name?: string;
        statusDetails?: { message?: string };
        status?: string;
        labels?: { name: string }[];
      }[];
      const match = results.find((r) => r.name === name);
      expect(match).toBeDefined();
      return match!;
    }

    it("sets statusDetails.message, marked with [nukadoko.failure=<kind>], for a failed step", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const stepRecord: StepRecord = {
        record_id: "step-fail-1",
        step: "the cart has items",
        kind: "run",
        args: {},
        status: "failed",
        environment: "staging",
        session: null,
        scenario: "scn-fail-1",
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:00.500Z",
        evidence: { dir: ".nukadoko/records/steps/step-fail-1", screenshots: [] },
        observed: { http_reads: 0, http_writes: 0 },
        mutates: true,
        error: { message: "it broke on purpose", kind: "step_error" },
      };
      writeStepRecordFile(rootDir, stepRecord);
      const record: ScenarioStepRecord = { text: "the cart has items", status: "failed", record: "step-fail-1" };

      emitter.beginScenario();
      emitter.emitStep(baseStepInput({ record, stepRecord, gherkinDocument, pickle, scenarioId: "scn-fail-1" }));

      const test = readStepResult("Given the cart has items");
      expect(test.status).toBe("failed");
      expect(test.statusDetails?.message).toBe("[nukadoko.failure=step_error] it broke on purpose");
      expect(test.labels).toContainEqual({ name: "nukadoko.failure", value: "step_error" });
    });

    it("leaves statusDetails unset for a passed step", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const record: ScenarioStepRecord = { text: "the cart has items", status: "passed", record: null };

      emitter.beginScenario();
      emitter.emitStep(baseStepInput({ record, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-pass-1" }));

      const test = readStepResult("Given the cart has items");
      expect(test.status).toBe("passed");
      expect(test.statusDetails?.message).toBeUndefined();
    });

    it("sets statusDetails.message to the plain (unmarked) message when the step has no resolvable kind", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const record: ScenarioStepRecord = {
        text: "the cart has items",
        status: "undefined",
        record: null,
        error: { message: "no matching step definition" },
      };

      emitter.beginScenario();
      emitter.emitStep(baseStepInput({ record, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-unresolved-1" }));

      const test = readStepResult("Given the cart has items");
      expect(test.statusDetails?.message).toBe("no matching step definition");
      expect(test.labels?.some((l) => l.name === "nukadoko.failure")).toBe(false);
    });

    it("marks a failing before hook's own fixture, but leaves the skipped steps it stops from running with no message of their own (step = test drops the old scenario-wide worst-of red test)", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const beforeHook: ScenarioHookRecord = {
        type: "before",
        status: "failed",
        error: { message: "hook blew up", kind: "step_error" },
      };
      const step: ScenarioStepRecord = { text: "the cart has items", status: "skipped", record: null };
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
        steps: [step],
        hooks: [beforeHook],
        evidence: { dir: ".nukadoko/records/scenarios/scn-hook-fail-1", screenshots: [] },
      };

      emitter.beginScenario();
      emitter.emitStep(baseStepInput({ record: step, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-hook-fail-1" }));
      emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

      const test = readStepResult("Given the cart has items");
      expect(test.status).toBe("skipped");
      expect(test.statusDetails?.message).toBeUndefined();

      const containers = readContainerFiles(resultsDir) as { befores: { status: string; statusDetails?: { message?: string } }[] }[];
      const beforeContainer = containers.find((c) => c.befores.length > 0)!;
      expect(beforeContainer.befores[0]!.status).toBe("failed");
      expect(beforeContainer.befores[0]!.statusDetails?.message).toBe("[nukadoko.failure=step_error] hook blew up");
    });
  });

  describe("failure isolation", () => {
    it("degrades gracefully (no throw, a normal result file) when a step's record.json simply doesn't exist", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const record: ScenarioStepRecord = {
        text: "the cart has items",
        status: "failed",
        record: "step-never-written",
        error: { message: "refused before it ever ran" },
      };

      emitter.beginScenario();
      expect(() =>
        emitter.emitStep(baseStepInput({ record, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-missing-record" })),
      ).not.toThrow();

      const results = readResultFiles(resultsDir);
      expect(results.some((r) => (r as { name?: string }).name === "Given the cart has items")).toBe(true);
    });

    it("catches a genuine internal failure (a step record claims an evidence file that isn't actually there), warns once to stderr, and leaves other steps' output intact", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;

      // A healthy step, emitted first, to prove its own output survives a
      // later step's own failure.
      emitter.beginScenario();
      emitter.emitStep(
        baseStepInput({
          record: { text: "the cart has items", status: "skipped", record: null },
          stepRecord: null,
          gherkinDocument,
          pickle,
          scenarioId: "scn-healthy",
        }),
      );
      const healthyFiles = new Set(readdirSync(resultsDir));

      // A step record whose own evidence.http names a file that was never
      // actually written — writeAttachmentFromPath's copyFileSync throws
      // ENOENT for it, a genuine internal failure that must never escape
      // emitStep.
      const stepRecord: StepRecord = {
        record_id: "step-broken",
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
        evidence: { dir: ".nukadoko/records/steps/step-broken", screenshots: [], http: "http.jsonl" },
        observed: { http_reads: 0, http_writes: 0 },
        mutates: true,
      };
      writeStepRecordFile(rootDir, stepRecord);
      // Deliberately not writing .nukadoko/records/steps/step-broken/http.jsonl.

      expect(() =>
        emitter.emitStep(
          baseStepInput({
            record: { text: "the cart has items", status: "passed", record: "step-broken" },
            stepRecord,
            gherkinDocument,
            pickle,
            scenarioId: "scn-broken",
          }),
        ),
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
    const resultsDir = path.join(rootDir, ".nukadoko", "export", "allure-results");
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
