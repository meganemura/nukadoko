import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFeatureSource } from "../src/feature/load-features.js";
import {
  createAllureEmitter,
  type AllureEmitter,
  type BeginScenarioInput,
  type EmitStepInput,
} from "../src/report/allure/emitter.js";
import type { StepRecord } from "../src/record/types.js";
import type { ScenarioHookRecord, ScenarioRecord, ScenarioStepRecord } from "../src/run/record-types.js";
import { createCaptureSink } from "./helpers/fixtures.js";

// Responsibility: integration tests — drives the real allure-js-commons
// ReporterRuntime end to end against fixture record.json/step record.json data
// (built here as plain objects, not by actually running a scenario) and
// reads the real files it writes back off disk. No `.feature` file on disk
// is needed either: `parseFeatureSource` takes source text directly.
//
// Rewritten around one pickle = one Allure test result, written once at
// `endScenario`: `beginScenario`/`emitStep`/`endScenario` are still three
// calls, but `emitStep` now only buffers a mapped `steps[]` entry — every
// assertion below that used to read "step1's own test"/"step2's own test"
// now reads the one result's own `steps` array instead.

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
  const dir = path.join(rootDir, ".nukadoko", "records", "steps", stepRecord.step_record_id);
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

/** A minimal, valid `BeginScenarioInput` — every test below overrides only
 * `pickle`/`gherkinDocument`, the two fields a fresh `parseFeatureSource`
 * call actually differs on from one test to the next. */
function baseBeginScenarioInput(
  overrides: Partial<BeginScenarioInput> & Pick<BeginScenarioInput, "pickle" | "gherkinDocument">,
): BeginScenarioInput {
  return {
    relativeFeaturePath: "features/checkout.feature",
    startedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
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
    let scenarioUuid: string | undefined;

    beforeEach(() => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;

      const recordDir = path.join(rootDir, ".nukadoko", "records", "steps", "step-1");
      mkdirSync(recordDir, { recursive: true });
      writeFileSync(path.join(recordDir, "note.txt"), "declared note");
      writeFileSync(path.join(recordDir, "http.jsonl"), '{"method":"GET","url":"https://x","status":200,"duration_ms":5}\n');

      const stepRecord1: StepRecord = {
        step_record_id: "step-1",
        step: "the cart has items",
        kind: "run",
        args: {},
        result: { ok: true },
        status: "ok",
        environment: "staging",
        session: "sess-1",
        target_version: "9.9.9",
        scenario_record_id: "scn-1",
        run_id: "run-1",
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
        step_record_id: "step-2",
        step: "the total is correct",
        kind: "run",
        args: {},
        result: null,
        status: "ok",
        environment: "staging",
        session: "sess-1",
        scenario_record_id: "scn-1",
        run_id: "run-1",
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

      const step1: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-1" };
      const step2: ScenarioStepRecord = { text: "the total is correct", status: "passed", step_record_id: "step-2" };
      const beforeHook: ScenarioHookRecord = {
        type: "before",
        status: "ok",
        declared: { attachments: ["hook-note.txt"], logs: ["hook did something"], parameters: [{ name: "hook-param", value: "y" }] },
      };
      const afterHook: ScenarioHookRecord = { type: "after", status: "ok" };

      emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
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
        scenario_record_id: "scn-1",
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
      scenarioUuid = (results.find((r) => (r as { name?: string }).name === "a customer checks out") as { uuid?: string } | undefined)?.uuid;
    });

    it("writes exactly one result.json for the whole scenario, never one per step plus one for the scenario", () => {
      const results = readResultFiles(resultsDir);
      expect(results).toHaveLength(1);
      expect((results[0] as { name?: string }).name).toBe("a customer checks out");
    });

    it("nests both steps under the one result's own steps[], keyword-prefixed, in order", () => {
      const results = readResultFiles(resultsDir);
      const result = results[0] as { steps?: { name: string; status: string }[] };
      expect(result.steps?.map((s) => s.name)).toEqual(["Given the cart has items", "Then the total is correct"]);
      expect(result.steps?.every((s) => s.status === "passed")).toBe(true);
    });

    it("carries feature/package/env labels, and never parentSuite/suite (the tree grouping this design drops)", () => {
      const results = readResultFiles(resultsDir);
      const result = results[0] as {
        fullName?: string;
        status?: string;
        labels?: { name: string; value: string }[];
        parameters?: { name: string; value: string; excluded?: boolean; mode?: string }[];
      };

      expect(result.fullName).toBe("acme-checkout:features/checkout.feature#a customer checks out");
      expect(result.status).toBe("passed");

      expect(result.labels).toContainEqual({ name: "feature", value: "Checkout" });
      expect(result.labels).toContainEqual({ name: "package", value: "acme-checkout.features.checkout.feature" });
      expect(result.labels).toContainEqual({ name: "env", value: "staging" });
      expect(result.labels?.some((l) => l.name === "parentSuite")).toBe(false);
      expect(result.labels?.some((l) => l.name === "suite")).toBe(false);

      expect(result.parameters).toContainEqual({ name: "environment", value: "staging", excluded: true });
      expect(result.parameters).toContainEqual({ name: "session", value: "sess-1", excluded: true });
      expect(result.parameters).toContainEqual({ name: "target_version", value: "9.9.9", excluded: true });
    });

    it("carries this scenario's own titlePath: project name, feature directory, feature name", () => {
      const results = readResultFiles(resultsDir);
      const result = results[0] as { titlePath?: string[] };
      expect(result.titlePath).toEqual(["acme-checkout", "features", "Checkout"]);
    });

    it("puts step1's own parameters/attachments on its own steps[] entry, kept off step2's own entry", () => {
      const results = readResultFiles(resultsDir);
      const result = results[0] as {
        steps?: {
          name: string;
          parameters?: { name: string; value: string }[];
          attachments?: { name: string; type: string; source?: string }[];
        }[];
      };
      const step1 = result.steps!.find((s) => s.name === "Given the cart has items")!;
      const step2 = result.steps!.find((s) => s.name === "Then the total is correct")!;

      expect(step1.parameters).toContainEqual({ name: "step record id", value: "step-1" });
      expect(step1.parameters).toContainEqual({ name: "mutates (declared)", value: "true" });

      const attachmentNames = step1.attachments!.map((a) => a.name).sort();
      expect(attachmentNames).toEqual(["declared: note.txt", "http log", "record.json", "result", "trace"]);
      const traceAttachment = step1.attachments!.find((a) => a.name === "trace") as { type: string };
      expect(traceAttachment.type).toBe("application/vnd.allure.playwright-trace");

      // Step1's own trace never leaks onto step2's own steps[] entry.
      expect(step2.attachments!.map((a) => a.name)).not.toContain("trace");
      // Neither step carries the *scenario's* own trace/screenshot -- those
      // attach directly to the result itself instead (checked
      // by a separate test below).
      expect(step2.attachments!.map((a) => a.name)).not.toContain("shot1.png");
    });

    it("hoists step1's own declared link onto the one result's own links (no second test left to keep it step-scoped)", () => {
      const results = readResultFiles(resultsDir);
      const result = results[0] as { links?: { url: string; name?: string }[] };
      expect(result.links).toContainEqual({ url: "https://issue.example/1", name: "issue-1" });
    });

    it("copies a step's own step record evidence.trace into resultsDir, attached to that step's own steps[] entry", () => {
      const results = readResultFiles(resultsDir);
      const result = results[0] as { steps?: { name: string; attachments: { name: string; source: string }[] }[] };
      const step1 = result.steps!.find((s) => s.name === "Given the cart has items")!;
      const trace = step1.attachments.find((a) => a.name === "trace")!;
      expect(readFileSync(path.join(resultsDir, trace.source), "utf8")).toBe("step trace bytes");
    });

    it("nests a declared log line directly under that step's own steps[] entry", () => {
      const results = readResultFiles(resultsDir);
      const result = results[0] as { steps?: { name: string; steps?: { name: string; status: string }[] }[] };
      const step1 = result.steps!.find((s) => s.name === "Given the cart has items")!;
      expect(step1.steps).toContainEqual(expect.objectContaining({ name: "did the thing", status: "passed" }));
    });

    it("copies the referenced evidence/declared files into resultsDir", () => {
      const results = readResultFiles(resultsDir);
      const result = results[0] as { steps?: { name: string; attachments: { name: string; source: string }[] }[] };
      const step1 = result.steps!.find((s) => s.name === "Given the cart has items")!;
      const declaredAttachment = step1.attachments.find((a) => a.name === "declared: note.txt")!;
      expect(readFileSync(path.join(resultsDir, declaredAttachment.source), "utf8")).toBe("declared note");
    });

    it("writes each hook as its own container, referencing the one result's own uuid in children", () => {
      const containers = readContainerFiles(resultsDir) as {
        children: string[];
        befores: { name: string; status: string; parameters?: { name: string; value: string }[] }[];
        afters: { name: string; status: string }[];
      }[];

      expect(scenarioUuid).toBeDefined();
      const beforeContainer = containers.find((c) => c.befores.length > 0)!;
      const afterContainer = containers.find((c) => c.afters.length > 0)!;

      expect(beforeContainer).toBeDefined();
      expect(afterContainer).toBeDefined();
      expect(beforeContainer.children).toContain(scenarioUuid);
      expect(afterContainer.children).toContain(scenarioUuid);
      expect(beforeContainer.befores[0]!.status).toBe("passed");
      expect(afterContainer.afters[0]!.status).toBe("passed");
      expect(beforeContainer.befores[0]!.parameters).toContainEqual({ name: "hook-param", value: "y" });
    });

    it("attaches the scenario's own trace/screenshot directly to the result, not any step and not a synthetic fixture", () => {
      const results = readResultFiles(resultsDir);
      const result = results[0] as { attachments?: { name: string; type: string; source: string }[] };
      const names = result.attachments!.map((a) => a.name).sort();
      expect(names).toEqual(["shot1.png", "trace"]);
      const trace = result.attachments!.find((a) => a.name === "trace")!;
      expect(readFileSync(path.join(resultsDir, trace.source), "utf8")).toBe("trace bytes");

      // No "Scenario evidence" fixture exists any more -- the container's
      // own afters list is exactly the real After hook this scenario ran,
      // nothing synthetic added on top.
      const containers = readContainerFiles(resultsDir) as { afters: { name: string }[] }[];
      const afterNames = containers.flatMap((c) => c.afters.map((a) => a.name));
      expect(afterNames).not.toContain("Scenario evidence");
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
    const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: null };
    const record: ScenarioRecord = {
      scenario_record_id: "scn-hook-trace-1",
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

    emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
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

  describe("identity: the one result links across runs, but never with an Outline row that isn't its own", () => {
    function runFullScenario(runId: string, scenarioId: string, gherkinDocument: any, pickle: any): void {
      emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
      pickle.steps.forEach((step: { text: string }, index: number) => {
        emitter.emitStep(
          baseStepInput({
            record: { text: step.text, status: "passed", step_record_id: null },
            stepRecord: null,
            gherkinDocument,
            pickle,
            runId,
            scenarioId,
            index,
          }),
        );
      });
      const record: ScenarioRecord = {
        scenario_record_id: scenarioId,
        run_id: runId,
        feature: "features/checkout.feature",
        scenario: pickle.name,
        line: 3,
        status: "passed",
        environment: "staging",
        session: null,
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:01.000Z",
        steps: pickle.steps.map(
          (step: { text: string }) => ({ text: step.text, status: "passed", step_record_id: null }) as ScenarioStepRecord,
        ),
        hooks: [],
        evidence: { dir: `.nukadoko/records/scenarios/${scenarioId}`, screenshots: [] },
      };
      emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });
    }

    it("gives the same historyId to two separate runs of the same scenario", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;

      runFullScenario("run-A", "scn-A", gherkinDocument, pickle);
      runFullScenario("run-B", "scn-B", gherkinDocument, pickle);

      const results = readResultFiles(resultsDir) as { historyId: string }[];
      expect(results).toHaveLength(2);
      expect(results[0]!.historyId).toBe(results[1]!.historyId);
    });

    it("gives two Scenario Outline rows sharing a run a different historyId (Examples values feed the hash)", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const outlineRows = pickles.filter((p) => p.name.startsWith("checkout as"));
      expect(outlineRows).toHaveLength(2);

      outlineRows.forEach((pickle, index) => {
        runFullScenario("run-A", `scn-outline-${index}`, gherkinDocument, pickle);
      });

      const results = readResultFiles(resultsDir) as { historyId: string }[];
      expect(results).toHaveLength(2);
      expect(results[0]!.historyId).not.toBe(results[1]!.historyId);
    });

    it("gives each Scenario Outline row its own SDK-derived testCaseId (md5 of that row's own fullName)", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const outlineRows = pickles.filter((p) => p.name.startsWith("checkout as"));
      expect(outlineRows).toHaveLength(2);

      outlineRows.forEach((pickle, index) => {
        runFullScenario("run-A", `scn-testcaseid-${index}`, gherkinDocument, pickle);
      });

      const results = readResultFiles(resultsDir) as { name: string; fullName: string; testCaseId: string }[];
      const rowResults = results.filter((r) => r.name.startsWith("checkout as"));
      expect(rowResults).toHaveLength(2);
      for (const row of rowResults) {
        expect(row.testCaseId).toBe(createHash("md5").update(row.fullName).digest("hex"));
      }
      expect(rowResults[0]!.testCaseId).not.toBe(rowResults[1]!.testCaseId);
    });
  });

  it("never deletes files from a previous emit into the same resultsDir", () => {
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles[0]!;
    const record: ScenarioRecord = {
      scenario_record_id: "scn-first",
      run_id: "run-1",
      feature: "features/checkout.feature",
      scenario: "a customer checks out",
      line: 3,
      status: "passed",
      environment: "staging",
      session: null,
      started_at: "2026-08-01T00:00:00.000Z",
      finished_at: "2026-08-01T00:00:00.000Z",
      steps: [{ text: "the cart has items", status: "skipped", step_record_id: null }],
      hooks: [],
      evidence: { dir: ".nukadoko/records/scenarios/scn-first", screenshots: [] },
    };
    emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
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
    secondEmitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
    secondEmitter.emitStep(
      baseStepInput({ record: record.steps[0]!, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-second" }),
    );
    secondEmitter.endScenario({
      record: { ...record, scenario_record_id: "scn-second" },
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

  describe("statusDetails.message and the classified-failure fallback", () => {
    function readResult(): {
      statusDetails?: { message?: string; trace?: string };
      status?: string;
      labels?: { name: string; value: string }[];
      steps?: { name: string; status: string; statusDetails?: { message?: string } }[];
    } {
      const results = readResultFiles(resultsDir);
      expect(results).toHaveLength(1);
      return results[0] as never;
    }

    it("sets the step's own statusDetails.message, marked with [nukadoko.failure=<kind>], and the same message + label on the result itself", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const stepRecord: StepRecord = {
        step_record_id: "step-fail-1",
        step: "the cart has items",
        kind: "run",
        args: {},
        status: "failed",
        environment: "staging",
        session: null,
        scenario_record_id: "scn-fail-1",
        run_id: "run-1",
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:00.500Z",
        evidence: { dir: ".nukadoko/records/steps/step-fail-1", screenshots: [] },
        observed: { http_reads: 0, http_writes: 0 },
        mutates: true,
        error: { message: "it broke on purpose", kind: "step_error" },
      };
      writeStepRecordFile(rootDir, stepRecord);
      const step: ScenarioStepRecord = { text: "the cart has items", status: "failed", step_record_id: "step-fail-1" };
      const record: ScenarioRecord = {
        scenario_record_id: "scn-fail-1",
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
        hooks: [],
        evidence: { dir: ".nukadoko/records/scenarios/scn-fail-1", screenshots: [] },
      };

      emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
      emitter.emitStep(baseStepInput({ record: step, stepRecord, gherkinDocument, pickle, scenarioId: "scn-fail-1" }));
      emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

      const result = readResult();
      expect(result.status).toBe("failed");
      expect(result.statusDetails?.message).toBe("[nukadoko.failure=step_error] it broke on purpose");
      expect(result.statusDetails?.trace).toBe("it broke on purpose");
      expect(result.labels).toContainEqual({ name: "nukadoko.failure", value: "step_error" });
      const stepEntry = result.steps!.find((s) => s.name === "Given the cart has items")!;
      expect(stepEntry.status).toBe("failed");
      expect(stepEntry.statusDetails?.message).toBe("[nukadoko.failure=step_error] it broke on purpose");
    });

    it("leaves statusDetails unset for a passed scenario", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: null };
      const record: ScenarioRecord = {
        scenario_record_id: "scn-pass-1",
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
        hooks: [],
        evidence: { dir: ".nukadoko/records/scenarios/scn-pass-1", screenshots: [] },
      };

      emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
      emitter.emitStep(baseStepInput({ record: step, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-pass-1" }));
      emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

      const result = readResult();
      expect(result.status).toBe("passed");
      expect(result.statusDetails?.message).toBeUndefined();
    });

    it("marks a failing Before hook's own fixture, leaves every skipped step with no message of its own, but still classifies the result itself via the hook fallback", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const beforeHook: ScenarioHookRecord = {
        type: "before",
        status: "failed",
        error: { message: "hook blew up", kind: "step_error" },
      };
      const step: ScenarioStepRecord = { text: "the cart has items", status: "skipped", step_record_id: null };
      const record: ScenarioRecord = {
        scenario_record_id: "scn-hook-fail-1",
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

      emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
      emitter.emitStep(baseStepInput({ record: step, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-hook-fail-1" }));
      emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

      const result = readResult();
      expect(result.status).toBe("failed");
      const stepEntry = result.steps!.find((s) => s.name === "Given the cart has items")!;
      expect(stepEntry.status).toBe("skipped");
      expect(stepEntry.statusDetails?.message).toBeUndefined();
      // The result itself still lands in a real category rather than
      // Allure 3's "Product errors" catch-all -- the classified Before
      // hook failure, since no step's own failure was classified.
      expect(result.labels).toContainEqual({ name: "nukadoko.failure", value: "step_error" });
      expect(result.statusDetails?.message).toBe("[nukadoko.failure=step_error] hook blew up");

      const containers = readContainerFiles(resultsDir) as { befores: { status: string; statusDetails?: { message?: string } }[] }[];
      const beforeContainer = containers.find((c) => c.befores.length > 0)!;
      expect(beforeContainer.befores[0]!.status).toBe("failed");
      expect(beforeContainer.befores[0]!.statusDetails?.message).toBe("[nukadoko.failure=step_error] hook blew up");
    });
  });

  describe("failure isolation", () => {
    it("degrades gracefully (no throw, a normal result file) when a step's own record is a never-began refusal", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;
      const step: ScenarioStepRecord = {
        text: "the cart has items",
        status: "failed",
        step_record_id: "step-never-written",
        error: { message: "refused before it ever ran" },
      };
      const record: ScenarioRecord = {
        scenario_record_id: "scn-missing-record",
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
        hooks: [],
        evidence: { dir: ".nukadoko/records/scenarios/scn-missing-record", screenshots: [] },
      };

      emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
      expect(() =>
        emitter.emitStep(baseStepInput({ record: step, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-missing-record" })),
      ).not.toThrow();
      expect(() =>
        emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" }),
      ).not.toThrow();

      const results = readResultFiles(resultsDir);
      expect(results.some((r) => (r as { name?: string }).name === "a customer checks out")).toBe(true);
    });

    it("catches a genuine internal failure at endScenario (a step record claims an evidence file that isn't actually there), warns once to stderr, and leaves an earlier scenario's own output intact", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;

      // A healthy scenario, run to completion first, to prove its own
      // output survives a later scenario's own failure -- one result per
      // scenario now, so "another step's output" (the old framing) has no
      // meaning inside the *same* scenario any more (this file's own
      // header).
      const healthyStep: ScenarioStepRecord = { text: "the cart has items", status: "skipped", step_record_id: null };
      emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
      emitter.emitStep(
        baseStepInput({ record: healthyStep, stepRecord: null, gherkinDocument, pickle, scenarioId: "scn-healthy" }),
      );
      emitter.endScenario({
        record: {
          scenario_record_id: "scn-healthy",
          run_id: "run-1",
          feature: "features/checkout.feature",
          scenario: "a customer checks out",
          line: 3,
          status: "passed",
          environment: "staging",
          session: null,
          started_at: "2026-08-01T00:00:00.000Z",
          finished_at: "2026-08-01T00:00:00.500Z",
          steps: [healthyStep],
          hooks: [],
          evidence: { dir: ".nukadoko/records/scenarios/scn-healthy", screenshots: [] },
        },
        gherkinDocument,
        pickle,
        relativeFeaturePath: "features/checkout.feature",
      });
      const healthyFiles = new Set(readdirSync(resultsDir));

      // A step record whose own evidence.http names a file that was never
      // actually written — writeAttachmentFromPath's copyFileSync throws
      // ENOENT for it, a genuine internal failure that must never escape
      // endScenario (this file's own header: every attachment write for the
      // whole scenario now happens inside that one call).
      const stepRecord: StepRecord = {
        step_record_id: "step-broken",
        step: "the cart has items",
        kind: "run",
        args: {},
        result: null,
        status: "ok",
        environment: "staging",
        session: null,
        scenario_record_id: "scn-broken",
        run_id: "run-1",
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:00.500Z",
        evidence: { dir: ".nukadoko/records/steps/step-broken", screenshots: [], http: "http.jsonl" },
        observed: { http_reads: 0, http_writes: 0 },
        mutates: true,
      };
      writeStepRecordFile(rootDir, stepRecord);
      // Deliberately not writing .nukadoko/records/steps/step-broken/http.jsonl.

      const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-broken" };
      const record: ScenarioRecord = {
        scenario_record_id: "scn-broken",
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
        hooks: [],
        evidence: { dir: ".nukadoko/records/scenarios/scn-broken", screenshots: [] },
      };

      emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
      emitter.emitStep(baseStepInput({ record: step, stepRecord, gherkinDocument, pickle, scenarioId: "scn-broken" }));
      expect(() =>
        emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" }),
      ).not.toThrow();

      expect(sink.text()).toContain("warning:");
      expect(sink.text()).toContain("scn-broken");

      const afterFiles = new Set(readdirSync(resultsDir));
      for (const name of healthyFiles) {
        expect(afterFiles.has(name)).toBe(true);
      }
    });
  });

  describe("calls -> nested Allure steps (docs/spec.md 'Parts')", () => {
    it("writes a part-of-a-part call as a genuinely nested step, args/result as parameters, under the calling step's own steps[] entry", () => {
      const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
      const pickle = pickles[0]!;

      const stepRecord: StepRecord = {
        step_record_id: "step-parts",
        step: "project-with-member",
        kind: "run",
        args: { email: "a@example.com" },
        result: { memberId: "m_1" },
        status: "ok",
        environment: "staging",
        session: null,
        scenario_record_id: "scn-parts",
        run_id: "run-1",
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:01.000Z",
        evidence: { dir: ".nukadoko/records/steps/step-parts", screenshots: [] },
        observed: { http_reads: 0, http_writes: 1 },
        mutates: true,
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
      };
      writeStepRecordFile(rootDir, stepRecord);
      const step: ScenarioStepRecord = { text: "the cart has items", status: "passed", step_record_id: "step-parts" };
      const record: ScenarioRecord = {
        scenario_record_id: "scn-parts",
        run_id: "run-1",
        feature: "features/checkout.feature",
        scenario: "a customer checks out",
        line: 3,
        status: "passed",
        environment: "staging",
        session: null,
        started_at: "2026-08-01T00:00:00.000Z",
        finished_at: "2026-08-01T00:00:01.000Z",
        steps: [step],
        hooks: [],
        evidence: { dir: ".nukadoko/records/scenarios/scn-parts", screenshots: [] },
      };

      emitter.beginScenario(baseBeginScenarioInput({ pickle, gherkinDocument }));
      emitter.emitStep(baseStepInput({ record: step, stepRecord, gherkinDocument, pickle, scenarioId: "scn-parts" }));
      emitter.endScenario({ record, gherkinDocument, pickle, relativeFeaturePath: "features/checkout.feature" });

      const results = readResultFiles(resultsDir);
      const result = results[0] as {
        steps?: {
          name: string;
          steps?: {
            name: string;
            status: string;
            parameters?: { name: string; value: string }[];
            steps?: { name: string; status: string; parameters?: { name: string; value: string }[] }[];
          }[];
        }[];
      };
      const stepEntry = result.steps!.find((s) => s.name === "Given the cart has items")!;

      expect(stepEntry.steps).toHaveLength(1);
      const inviteMemberStep = stepEntry.steps![0]!;
      expect(inviteMemberStep.name).toBe("invite-member");
      expect(inviteMemberStep.status).toBe("passed");
      expect(inviteMemberStep.parameters).toContainEqual({
        name: "args",
        value: JSON.stringify({ projectId: "p_1", email: "a@example.com" }),
      });
      expect(inviteMemberStep.parameters).toContainEqual({
        name: "result",
        value: JSON.stringify({ memberId: "m_1" }),
      });

      expect(inviteMemberStep.steps).toHaveLength(1);
      const sendInviteStep = inviteMemberStep.steps![0]!;
      expect(sendInviteStep.name).toBe("send-invite");
      expect(sendInviteStep.status).toBe("passed");
      expect(sendInviteStep.parameters).toContainEqual({
        name: "result",
        value: JSON.stringify({ sent: true, channel: "email" }),
      });
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
