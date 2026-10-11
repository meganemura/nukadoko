import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { createStepContext } from "../src/context/create-context.js";
import { pollWithRecording, type PollOutcome } from "../src/context/poll.js";
import { InvalidPollOptionsError, PollTimeoutError } from "../src/index.js";

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
    oaths: [],
    stateDir: ".nukadoko",
    envFiles: [],
    parameterTypes: [],
    fixtures: {},
    fixtureTimeout: 60_000,
    secrets: { public: [], redact: [] },
    retention: { runs: 20, adHocDays: 7 },
    stepTimeout: 1_200_000,
    browserType: "chromium",
    worldParameters: {},
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

  // The timeout is a budget for the whole call. A deadline checked only
  // after an attempt has already finished lets that attempt, and the sleep
  // before the next one, run past it. A non-finite timeout never satisfies
  // the comparison, so the loop does not end.
  it("does not return a value from an attempt that outlasts the timeout", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    const started = Date.now();
    const outcome = await outcomeWithin(
      ctx.poll(
        async () => {
          await delay(600);
          return "late";
        },
        { timeout: 100, interval: 10 },
      ),
      400,
    );
    expect(outcome).toBeInstanceOf(PollTimeoutError);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("does not take another attempt once waiting the interval would pass the timeout", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    let calls = 0;
    const started = Date.now();
    const outcome = await outcomeWithin(
      ctx.poll(
        async () => {
          calls += 1;
          return calls >= 2 ? "late" : undefined;
        },
        { timeout: 80, interval: 500 },
      ),
      400,
    );
    expect(outcome).toBeInstanceOf(PollTimeoutError);
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("times out a fn that never settles", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    const started = Date.now();
    const outcome = await outcomeWithin(
      ctx.poll(() => new Promise(() => {}), { timeout: 120, interval: 20 }),
      400,
    );
    expect(outcome).toBeInstanceOf(PollTimeoutError);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("ends when timeout is NaN", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    const started = Date.now();
    const outcome = await outcomeWithin(
      ctx.poll(async () => undefined, { timeout: Number.NaN, interval: 20 }),
      300,
    );
    expect(outcome).toBeInstanceOf(InvalidPollOptionsError);
    expect(Date.now() - started).toBeLessThan(300);
  });

  it("ends when interval is NaN", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    const started = Date.now();
    const outcome = await outcomeWithin(
      ctx.poll(async () => undefined, { timeout: 5_000, interval: Number.NaN }),
      300,
    );
    expect(outcome).toBeInstanceOf(InvalidPollOptionsError);
    expect(Date.now() - started).toBeLessThan(300);
  });

  it.each([
    { timeout: 0, interval: 10 },
    { timeout: -5, interval: 10 },
    { timeout: Number.POSITIVE_INFINITY, interval: 10 },
    { timeout: 100, interval: 0 },
    { timeout: 100, interval: -1 },
    { timeout: 100, interval: Number.POSITIVE_INFINITY },
  ])("refuses a non-positive or non-finite timeout or interval (%j) before calling fn", async (options) => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    let calls = 0;
    const outcome = await outcomeWithin(
      ctx.poll(async () => {
        calls += 1;
        return "ready";
      }, options),
      300,
    );
    expect(outcome).toBeInstanceOf(InvalidPollOptionsError);
    expect(calls).toBe(0);
  });

  it("records timed_out, not a late rejection, when fn never settles and then rejects", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    let rejectLate: (error: Error) => void = () => {};
    const outcome = await outcomeWithin(
      ctx.poll(
        () =>
          new Promise<undefined>((_resolve, reject) => {
            rejectLate = reject;
          }),
        { timeout: 40, interval: 10 },
      ),
      400,
    );
    expect(outcome).toBeInstanceOf(PollTimeoutError);
    const unhandled = new Promise<unknown>((resolve) => {
      const onUnhandled = (error: unknown) => resolve(error);
      process.once("unhandledRejection", onUnhandled);
      rejectLate(new Error("late"));
      setTimeout(() => {
        process.removeListener("unhandledRejection", onUnhandled);
        resolve(undefined);
      }, 30);
    });
    expect(await unhandled).toBeUndefined();
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Resolves with the poll's value, the error it rejected with, or "pending"
// once `limitMs` has passed. The limit is what makes a poll that never
// settles fail the test instead of holding the run.
async function outcomeWithin(work: Promise<unknown>, limitMs: number): Promise<unknown> {
  return Promise.race([
    work.then(
      (value) => value,
      (error: unknown) => error,
    ),
    delay(limitMs).then(() => "pending"),
  ]);
}

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

  it("reports one timed_out attempt when fn has not settled by the budget", async () => {
    const progressCalls: number[] = [];
    let finished: PollOutcome | undefined;
    await expect(
      pollWithRecording(
        () => new Promise(() => {}),
        { timeout: 40, interval: 10 },
        (outcome) => {
          finished = outcome;
        },
        (attempts) => progressCalls.push(attempts),
      ),
    ).rejects.toBeInstanceOf(PollTimeoutError);
    expect(progressCalls).toEqual([1]);
    expect(finished?.attempts).toBe(1);
    expect(finished?.outcome).toBe("timed_out");
    expect(finished?.waitedMs).toBeLessThan(300);
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
