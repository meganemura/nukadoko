import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { createStepContext } from "../src/context/create-context.js";
import { PollTimeoutError } from "../src/index.js";

// Responsibility: `ctx.poll`'s own retry-loop behavior (ctx-poll-receipt
// task spec), unchanged from the pre-ctx-poll-receipt `poll` import this
// replaces — only the call site moved (`ctx.poll(fn, options)` instead of
// `poll(fn, options)`, via a real `ctx` from createStepContext, the same way
// tests/create-context.test.ts exercises other `ctx` members). What the
// receipt actually records from a finished poll is tests/polls.test.ts's
// job, not this file's.

interface Job {
  id: string;
}

function baseConfig(overrides: Partial<NukadokoConfig> = {}): NukadokoConfig {
  return {
    featuresDir: "features",
    additionalFeatureDirs: [],
    stateDir: ".nukadoko",
    envFiles: [],
    parameterTypes: [],
    fixtures: {},
    fixtureTimeout: 60_000,
    secrets: { public: [], redact: [] },
    browserType: "chromium",
    ...overrides,
  };
}

describe("ctx.poll", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-poll-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("resolves to T (not T | undefined) for fn: () => Promise<T | undefined>, usable without a cast", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    const fetchJob = async (): Promise<Job | undefined> => ({ id: "job-1" });
    const job = await ctx.poll(fetchJob, { interval: 5, timeout: 50 });
    expectTypeOf(job).toEqualTypeOf<Job>();
    expect(job.id).toBe("job-1");
  });

  it("returns the value once fn stops returning undefined", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    let calls = 0;
    const value = await ctx.poll(
      async () => {
        calls += 1;
        return calls >= 3 ? "ready" : undefined;
      },
      { interval: 5, timeout: 2000 },
    );
    expect(value).toBe("ready");
    expect(calls).toBe(3);
  });

  it("throws PollTimeoutError naming the timeout and description when fn never resolves", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    const attempt = ctx.poll(async () => undefined, {
      timeout: 30,
      interval: 10,
      description: "widget to become ready",
    });

    await expect(attempt).rejects.toBeInstanceOf(PollTimeoutError);
  });

  it("includes the description in the timeout error message", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    await expect(
      ctx.poll(async () => undefined, {
        timeout: 30,
        interval: 10,
        description: "widget to become ready",
      }),
    ).rejects.toThrow(/widget to become ready/);
  });

  it("omits any 'while ...' clause when no description is given", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    await expect(ctx.poll(async () => undefined, { timeout: 20, interval: 10 })).rejects.toThrow(
      /^poll timed out after 20ms$/,
    );
  });

  it("propagates fn's own throw unchanged, without wrapping it", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    const boom = new Error("boom from fn");
    await expect(
      ctx.poll(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});
