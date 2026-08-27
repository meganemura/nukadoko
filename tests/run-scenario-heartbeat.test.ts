import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFeatureSource } from "../src/feature/load-features.js";
import { createAllureEmitter } from "../src/report/allure/emitter.js";
import { runWithHeartbeat } from "../src/run/run-scenario.js";
import { createCaptureSink } from "./helpers/fixtures.js";

// Responsibility: `runWithHeartbeat`'s own contract (src/run/run-scenario.ts),
// tested with an injected `intervalMs`/`cap` rather than the fixed
// ten-second/120-tick pair every real call site uses, exactly so this file
// never depends on real wall-clock time longer than a few tens of
// milliseconds. The second describe block below drives `runWithHeartbeat`
// together with a real `createAllureEmitter`, proving three things through
// the same two functions run-scenario.ts wires together in production: a
// step running longer than the interval produces progress-snapshot files, a
// step finishing before the interval elapses produces no extra one, and
// reaching the tick cap stops new snapshots without stopping the step
// itself. What this file does not cover is run-scenario.ts's own roughly
// ten lines of wiring (`withStepHeartbeat`/`reportStepHeartbeat`) that read
// `contextHandle.livePollsSnapshot()`/`sectionsSnapshot()` and pass
// `stepIndex`/`stepStartedAt` through. Exercising that would need a full
// `runScenario()` call (discovery, a real pickle, a real fixture graph),
// which no existing test in this repository sets up; tests/poll.test.ts's
// own "createStepContext: livePollsSnapshot" block already proves the one
// non-trivial piece of that wiring, the live-poll source itself, in
// isolation.

const FEATURE_SOURCE = `Feature: Checkout
  Scenario: a customer checks out
    Given the cart has items
    Then the total is correct
`;

describe("runWithHeartbeat", () => {
  it("calls onTick repeatedly while run() is still pending, and stops once run() settles", async () => {
    let resolveRun: (() => void) | undefined;
    const run = () => new Promise<string>((resolve) => (resolveRun = () => resolve("done")));
    let ticks = 0;
    const promise = runWithHeartbeat(run, () => (ticks += 1), 5, 100);

    // Long enough, at a 5ms interval, for several ticks to have fired while
    // run() is still unresolved. This is a generous margin, not an exact count.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(ticks).toBeGreaterThan(0);
    const ticksBeforeResolve = ticks;

    resolveRun?.();
    await expect(promise).resolves.toBe("done");

    // The interval is cleared in `finally`, before this function returns --
    // no further tick can land after that, real time or not.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ticks).toBe(ticksBeforeResolve);
  });

  it("never calls onTick when run() resolves before the first interval elapses", async () => {
    let ticks = 0;
    // 1000ms interval: a run() that resolves through a bare microtask
    // finishes many orders of magnitude before that, with no real race.
    const value = await runWithHeartbeat(async () => "fast", () => (ticks += 1), 1000, 10);
    expect(value).toBe("fast");
    expect(ticks).toBe(0);
  });

  it("stops ticking once cap is reached, but run() keeps going until it settles on its own", async () => {
    let resolveRun: (() => void) | undefined;
    const run = () => new Promise<string>((resolve) => (resolveRun = () => resolve("done")));
    let ticks = 0;
    const promise = runWithHeartbeat(run, () => (ticks += 1), 3, 2);

    // Far longer than 2 * 3ms. If the cap did not stop the timer, this
    // window would have produced well more than 2 ticks.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ticks).toBe(2);

    resolveRun?.();
    await expect(promise).resolves.toBe("done");
    expect(ticks).toBe(2);
  });

  it("propagates run()'s own throw unchanged", async () => {
    const boom = new Error("boom from run");
    let ticks = 0;
    await expect(
      runWithHeartbeat(
        async () => {
          throw boom;
        },
        () => (ticks += 1),
        1000,
        10,
      ),
    ).rejects.toBe(boom);
  });
});

// Responsibility: the same two functions run-scenario.ts's own step-
// execution call sites wire together (`runWithHeartbeat` and
// `AllureEmitter.emitStepProgress`), driven directly against a real
// `createAllureEmitter`, proving a long-running step actually produces
// progress-snapshot files on disk, a fast one does not, and reaching the cap
// stops new files without stopping the underlying `run()`.
describe("runWithHeartbeat + AllureEmitter.emitStepProgress", () => {
  let rootDir: string;
  let resultsDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-heartbeat-"));
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: "acme-checkout" }));
    resultsDir = path.join(rootDir, ".nukadoko", "export", "allure-results");
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function progressFileCount(): number {
    return readdirSync(resultsDir).filter((name) => name.endsWith("-progress-result.json")).length;
  }

  it("a step running longer than the interval produces progress snapshots beyond beginScenario's own", async () => {
    const emitter = createAllureEmitter({
      resultsDir,
      rootDir,
      environment: "staging",
      secrets: [],
      stderr: createCaptureSink(),
      heartbeatCap: 5,
    });
    emitter.begin();
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles.find((p) => p.name === "a customer checks out")!;
    emitter.beginScenario({
      pickle,
      gherkinDocument,
      relativeFeaturePath: "features/checkout.feature",
      startedAt: new Date(),
    });
    expect(progressFileCount()).toBe(1);

    let resolveRun: (() => void) | undefined;
    const run = () => new Promise<void>((resolve) => (resolveRun = resolve));
    const stepStartedAt = new Date();
    let tickCount = 0;
    const promise = runWithHeartbeat(
      run,
      () => {
        tickCount += 1;
        emitter.emitStepProgress({
          scenarioId: "scn-1",
          index: 0,
          startedAt: stepStartedAt,
          liveItems: [`section: attempt ${tickCount}`],
          gherkinDocument,
          pickle,
          relativeFeaturePath: "features/checkout.feature",
        });
      },
      5,
      5,
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    resolveRun?.();
    await promise;

    expect(tickCount).toBeGreaterThan(0);
    // beginScenario's own snapshot plus at least one heartbeat write.
    expect(progressFileCount()).toBeGreaterThan(1);
  });

  it("a step finishing before the interval elapses produces no extra snapshot beyond beginScenario's own", async () => {
    const emitter = createAllureEmitter({
      resultsDir,
      rootDir,
      environment: "staging",
      secrets: [],
      stderr: createCaptureSink(),
    });
    emitter.begin();
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles.find((p) => p.name === "a customer checks out")!;
    emitter.beginScenario({
      pickle,
      gherkinDocument,
      relativeFeaturePath: "features/checkout.feature",
      startedAt: new Date(),
    });
    expect(progressFileCount()).toBe(1);

    let tickCount = 0;
    // 1000ms interval: an already-resolved run() settles long before the
    // first tick could ever fire.
    await runWithHeartbeat(
      async () => "fast",
      () => {
        tickCount += 1;
        emitter.emitStepProgress({
          scenarioId: "scn-1",
          index: 0,
          startedAt: new Date(),
          liveItems: ["section: should never appear"],
          gherkinDocument,
          pickle,
          relativeFeaturePath: "features/checkout.feature",
        });
      },
      1000,
      10,
    );

    expect(tickCount).toBe(0);
    expect(progressFileCount()).toBe(1);
  });

  it("stops writing new snapshots once the cap is reached, while the step itself keeps running", async () => {
    const emitter = createAllureEmitter({
      resultsDir,
      rootDir,
      environment: "staging",
      secrets: [],
      stderr: createCaptureSink(),
      heartbeatCap: 2,
    });
    emitter.begin();
    const { gherkinDocument, pickles } = parseFeatureSource(FEATURE_SOURCE, "features/checkout.feature");
    const pickle = pickles.find((p) => p.name === "a customer checks out")!;
    emitter.beginScenario({
      pickle,
      gherkinDocument,
      relativeFeaturePath: "features/checkout.feature",
      startedAt: new Date(),
    });
    expect(progressFileCount()).toBe(1);

    let resolveRun: (() => void) | undefined;
    const run = () => new Promise<void>((resolve) => (resolveRun = resolve));
    let tickCount = 0;
    const promise = runWithHeartbeat(
      run,
      () => {
        tickCount += 1;
        emitter.emitStepProgress({
          scenarioId: "scn-1",
          index: 0,
          startedAt: new Date(),
          liveItems: [`section: attempt ${tickCount}`],
          gherkinDocument,
          pickle,
          relativeFeaturePath: "features/checkout.feature",
        });
      },
      3,
      2,
    );

    // Far longer than 2 * 3ms. The cap, not this window, is what stops
    // the ticks (and the file count) at 2.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(tickCount).toBe(2);
    expect(progressFileCount()).toBe(3); // beginScenario's own + 2 heartbeats

    // The step itself is untouched by the cap: it is still running, and
    // still finishes normally once resolved.
    resolveRun?.();
    await expect(promise).resolves.toBeUndefined();
    expect(tickCount).toBe(2);
  });
});
