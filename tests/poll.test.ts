import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { createStepContext } from "../src/context/create-context.js";
import { pollWithRecording, type PollOutcome } from "../src/context/poll.js";
import { PollTimeoutError } from "../src/index.js";

// Responsibility: `ctx.poll`'s own retry-loop behavior, unchanged from the
// pre-ctx-poll-step-record `poll` import this
// replaces — only the call site moved (`ctx.poll(fn, options)` instead of
// `poll(fn, options)`, via a real `ctx` from createStepContext, the same way
// tests/create-context.test.ts exercises other `ctx` members). What the
// step record actually records from a finished poll is tests/polls.test.ts's
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

// Responsibility: `pollWithRecording`'s own per-iteration `onProgress`
// callback, the seam a step's own heartbeat (src/run/run-scenario.ts) needs
// to know a poll is still running. Called directly, bypassing `ctx.poll`,
// since this is about the retry loop's own contract, not create-context.ts's
// wiring of it (that half is the "createStepContext: livePollsSnapshot"
// block below). None of the existing assertions in the "ctx.poll" describe
// block above changed: `onFinish`'s own content, when it fires, and how a
// timeout/throw propagate are all unchanged by this parameter existing.
describe("pollWithRecording: onProgress", () => {
  it("is called once per attempt, matching the attempts count onFinish reports for a poll that eventually resolves", async () => {
    const progressCalls: number[] = [];
    let finished: PollOutcome | undefined;
    let calls = 0;
    const value = await pollWithRecording(
      async () => {
        calls += 1;
        return calls >= 3 ? "ready" : undefined;
      },
      { interval: 1, timeout: 2000 },
      (outcome) => {
        finished = outcome;
      },
      (attempts) => progressCalls.push(attempts),
    );
    expect(value).toBe("ready");
    expect(progressCalls).toEqual([1, 2, 3]);
    expect(finished?.attempts).toBe(3);
    expect(finished?.outcome).toBe("resolved");
  });

  it("is called once, for the one attempt made, when fn throws: onFinish still reports failed and the throw still propagates unchanged", async () => {
    const boom = new Error("boom from fn");
    const progressCalls: number[] = [];
    let finished: PollOutcome | undefined;
    await expect(
      pollWithRecording(
        async () => {
          throw boom;
        },
        {},
        (outcome) => {
          finished = outcome;
        },
        (attempts) => progressCalls.push(attempts),
      ),
    ).rejects.toBe(boom);
    expect(progressCalls).toEqual([1]);
    expect(finished?.outcome).toBe("failed");
  });

  it("is called for every attempt made before a timeout, matching onFinish's own attempts and outcome", async () => {
    const progressCalls: number[] = [];
    let finished: PollOutcome | undefined;
    await expect(
      pollWithRecording(
        async () => undefined,
        { timeout: 20, interval: 5 },
        (outcome) => {
          finished = outcome;
        },
        (attempts) => progressCalls.push(attempts),
      ),
    ).rejects.toBeInstanceOf(PollTimeoutError);
    expect(progressCalls.length).toBeGreaterThan(0);
    expect(finished?.attempts).toBe(progressCalls.length);
    expect(finished?.outcome).toBe("timed_out");
  });

  it("is optional: omitting it changes nothing about a poll's own resolution", async () => {
    const value = await pollWithRecording(async () => "ok", {}, () => {});
    expect(value).toBe("ok");
  });
});

// Responsibility: `createStepContext`'s own `livePollsSnapshot()`, the
// "current activity" a step's own heartbeat reads while `ctx.poll` is still
// waiting (docs comment on `LivePollEntry`, create-context.ts). A finished
// poll is never in this list; that half already belongs to `polls`
// (tests/polls.test.ts's own job).
describe("createStepContext: livePollsSnapshot (heartbeat feed)", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-poll-live-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("shows nothing before any ctx.poll call, and nothing after one completes", async () => {
    const { ctx, livePollsSnapshot } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    expect(livePollsSnapshot()).toEqual([]);
    await ctx.poll(async () => "done", { interval: 1, timeout: 100 });
    expect(livePollsSnapshot()).toEqual([]);
  });

  it("shows the poll's own description and a growing attempt count while it is still in flight", async () => {
    const { ctx, livePollsSnapshot } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    let calls = 0;
    const seenAttempts: number[] = [];
    const value = await ctx.poll(
      async () => {
        calls += 1;
        const [entry] = livePollsSnapshot();
        seenAttempts.push(entry!.attempts);
        expect(entry!.description).toBe("widget to become ready");
        return calls >= 3 ? "ready" : undefined;
      },
      { interval: 1, timeout: 2000, description: "widget to become ready" },
    );
    expect(value).toBe("ready");
    expect(seenAttempts).toEqual([1, 2, 3]);
    expect(livePollsSnapshot()).toEqual([]);
  });

  it("tracks two ctx.poll calls made from the same step independently, neither overwriting the other's entry", () => {
    const { ctx, livePollsSnapshot } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    // Both calls below run synchronously up to their own first `await`.
    // `pollWithRecording` calls `onProgress` before that point (poll.ts's
    // own doc comment), so this assertion reads both entries before
    // either poll's own `fn` has had a chance to settle, with no real timer
    // involved at all.
    void ctx.poll(async () => "a", { interval: 5, timeout: 2000, description: "a" });
    void ctx.poll(async () => "b", { interval: 5, timeout: 2000, description: "b" });
    expect(livePollsSnapshot().map((entry) => entry.description).sort()).toEqual(["a", "b"]);
  });

  it("clears at beginStep, the same reset every other per-step collector already gets", async () => {
    const { livePollsSnapshot, beginStep } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    expect(livePollsSnapshot()).toEqual([]);
    await expect(beginStep(evidenceDir)).resolves.toBeUndefined();
    expect(livePollsSnapshot()).toEqual([]);
  });
});
