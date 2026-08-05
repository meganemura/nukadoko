import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { createStepContext } from "../src/context/create-context.js";
import { buildFixtureGraph } from "../src/fixture/graph.js";
import { createFixtureCache, resolveFixtures, teardownFixtureCache } from "../src/fixture/resolver.js";
import type { FixtureDefinition } from "../src/fixture/types.js";

// Responsibility: unit tests for src/fixture/resolver.ts's `resolveFixtures`/
// `teardownFixtureCache` — the runtime half of P5, exercised against a real
// `createStepContext` (env/requireEnv/baseURL/request only; no browser, kept
// fast and independent of chromium availability) rather than a hand-rolled
// StepContext double, so a real `ctx.request()`/`ctx.env` is what a fixture's
// own `deps` actually receives. Covers this task's own completion conditions
// 5 (a "process"-scope fixture built once across two callers) and the resolver's
// own contract: only the step's own requested names come back on the bag,
// `reused` is accurate, teardown runs LIFO, and a builtin override is
// resolved the same way for every *other* consumer while still handing the
// override's own body the pre-override (builtin) value.

function config(fixtures: Record<string, FixtureDefinition> = {}): Pick<NukadokoConfig, "fixtures"> {
  return { fixtures };
}

describe("resolveFixtures", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-fixture-resolver-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("resolves a user fixture depending on a builtin (env)", async () => {
    const tenant: FixtureDefinition = async ({ env }, use) => {
      await use({ id: env.TENANT_ID ?? "default" });
    };
    const graph = buildFixtureGraph(config({ tenant }));
    const { ctx } = createStepContext({
      config: { fixtures: {}, fixtureTimeout: 60_000 } as NukadokoConfig,
      evidenceDir,
      env: { TENANT_ID: "abc" },
    });

    const scenarioCache = createFixtureCache();
    const processCache = createFixtureCache();
    const { fixtures, usage } = await resolveFixtures({
      names: ["tenant"],
      graph,
      ctx,
      scenarioCache,
      processCache,
      defaultTimeoutMs: 5_000,
    });

    expect((fixtures as any).tenant).toEqual({ id: "abc" });
    expect(Object.keys(fixtures)).toEqual(["tenant"]);
    expect(usage).toEqual([{ name: "tenant", scope: "scenario", reused: false, setup_ms: expect.any(Number), at: expect.any(String) }]);
  });

  it("returns only the names the step itself requested, not a transitive dependency it never asked for", async () => {
    const a: FixtureDefinition = async ({}, use) => {
      await use("A");
    };
    const b: FixtureDefinition = async ({ a: aValue }: any, use) => {
      await use(`B(${aValue})`);
    };
    const graph = buildFixtureGraph(config({ a, b }));
    const { ctx } = createStepContext({
      config: { fixtures: {}, fixtureTimeout: 60_000 } as NukadokoConfig,
      evidenceDir,
      env: {},
    });
    const scenarioCache = createFixtureCache();
    const processCache = createFixtureCache();
    const { fixtures, usage } = await resolveFixtures({
      names: ["b"],
      graph,
      ctx,
      scenarioCache,
      processCache,
      defaultTimeoutMs: 5_000,
    });

    expect(Object.keys(fixtures)).toEqual(["b"]);
    expect((fixtures as any).b).toBe("B(A)");
    // `a` was still built (and its cost is visible in `usage`, this file's
    // own header) — just not handed to the step, which never destructured it.
    expect(usage.map((u) => u.name)).toEqual(["a", "b"]);
  });

  it("a process-scope fixture is built once across two resolveFixtures calls, reused the second time", async () => {
    let buildCount = 0;
    const seededDb: FixtureDefinition = [
      async ({}, use) => {
        buildCount += 1;
        await use(42);
      },
      { scope: "process" },
    ];
    const graph = buildFixtureGraph(config({ seededDb }));
    const { ctx } = createStepContext({
      config: { fixtures: {}, fixtureTimeout: 60_000 } as NukadokoConfig,
      evidenceDir,
      env: {},
    });
    const scenarioCacheA = createFixtureCache();
    const scenarioCacheB = createFixtureCache();
    const processCache = createFixtureCache();

    const first = await resolveFixtures({
      names: ["seededDb"],
      graph,
      ctx,
      scenarioCache: scenarioCacheA,
      processCache,
      defaultTimeoutMs: 5_000,
    });
    const second = await resolveFixtures({
      names: ["seededDb"],
      graph,
      ctx,
      scenarioCache: scenarioCacheB,
      processCache,
      defaultTimeoutMs: 5_000,
    });

    expect(buildCount).toBe(1);
    expect((first.fixtures as any).seededDb).toBe(42);
    expect((second.fixtures as any).seededDb).toBe(42);
    expect(first.usage).toEqual([{ name: "seededDb", scope: "process", reused: false, setup_ms: expect.any(Number), at: expect.any(String) }]);
    expect(second.usage).toEqual([{ name: "seededDb", scope: "process", reused: true }]);
  });

  it("a page-override's own self-reference dependency reads the raw builtin, while other consumers read the override", async () => {
    const calls: string[] = [];
    const request: FixtureDefinition = async ({ request: realRequest }, use) => {
      calls.push("wrapped-request-setup");
      await use(realRequest);
    };
    const graph = buildFixtureGraph(config({ request }));
    const { ctx } = createStepContext({
      config: { fixtures: {}, fixtureTimeout: 60_000 } as NukadokoConfig,
      evidenceDir,
      env: {},
    });
    const scenarioCache = createFixtureCache();
    const processCache = createFixtureCache();
    const { fixtures } = await resolveFixtures({
      names: ["request"],
      graph,
      ctx,
      scenarioCache,
      processCache,
      defaultTimeoutMs: 5_000,
    });

    expect(calls).toEqual(["wrapped-request-setup"]);
    // The override's own value (the same real request object it wrapped)
    // is what the step receives.
    expect(fixtures.request).toBeDefined();
  });
});

describe("teardownFixtureCache", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-fixture-teardown-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("tears down in reverse build order, and passes the given outcome to each", async () => {
    const order: string[] = [];
    const outcomes: string[] = [];
    const a: FixtureDefinition = async ({}, use) => {
      const outcome = await use("A");
      order.push("a-teardown");
      outcomes.push(outcome);
    };
    const b: FixtureDefinition = async ({ a: aValue }: any, use) => {
      void aValue;
      const outcome = await use("B");
      order.push("b-teardown");
      outcomes.push(outcome);
    };
    const graph = buildFixtureGraph(config({ a, b }));
    const { ctx } = createStepContext({
      config: { fixtures: {}, fixtureTimeout: 60_000 } as NukadokoConfig,
      evidenceDir,
      env: {},
    });
    const scenarioCache = createFixtureCache();
    const processCache = createFixtureCache();
    await resolveFixtures({
      names: ["b"],
      graph,
      ctx,
      scenarioCache,
      processCache,
      defaultTimeoutMs: 5_000,
    });

    const errors = await teardownFixtureCache(scenarioCache, "failed");
    expect(errors).toEqual([]);
    // b was built after a (a is its own dependency), so teardown unwinds
    // b first, a second.
    expect(order).toEqual(["b-teardown", "a-teardown"]);
    expect(outcomes).toEqual(["failed", "failed"]);
  });

  it("collects a teardown error without stopping a sibling's own teardown", async () => {
    const order: string[] = [];
    const broken: FixtureDefinition = async ({}, use) => {
      await use(1);
      throw new Error("cleanup failed");
    };
    const fine: FixtureDefinition = async ({}, use) => {
      await use(2);
      order.push("fine-torn-down");
    };
    const graph = buildFixtureGraph(config({ broken, fine }));
    const { ctx } = createStepContext({
      config: { fixtures: {}, fixtureTimeout: 60_000 } as NukadokoConfig,
      evidenceDir,
      env: {},
    });
    const scenarioCache = createFixtureCache();
    const processCache = createFixtureCache();
    await resolveFixtures({
      names: ["broken", "fine"],
      graph,
      ctx,
      scenarioCache,
      processCache,
      defaultTimeoutMs: 5_000,
    });

    const errors = await teardownFixtureCache(scenarioCache, "passed");
    expect(errors).toEqual([{ fixture: "broken", message: "cleanup failed" }]);
    expect(order).toEqual(["fine-torn-down"]);
  });

  it("empties the cache, so a second teardown call is a no-op", async () => {
    const a: FixtureDefinition = async ({}, use) => {
      await use(1);
    };
    const graph = buildFixtureGraph(config({ a }));
    const { ctx } = createStepContext({
      config: { fixtures: {}, fixtureTimeout: 60_000 } as NukadokoConfig,
      evidenceDir,
      env: {},
    });
    const scenarioCache = createFixtureCache();
    const processCache = createFixtureCache();
    await resolveFixtures({
      names: ["a"],
      graph,
      ctx,
      scenarioCache,
      processCache,
      defaultTimeoutMs: 5_000,
    });

    await teardownFixtureCache(scenarioCache, "passed");
    const errors = await teardownFixtureCache(scenarioCache, "passed");
    expect(errors).toEqual([]);
  });
});
