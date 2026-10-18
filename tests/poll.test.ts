import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
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
  // the comparison, so the loop does not end. An attempt here settles only
  // when the test releases it, so a poll that waited for it would never
  // end, and its ending at all shows the budget cut it off.
  it("does not return a value from an attempt that outlasts the timeout", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    let releaseLate: () => void = () => {};
    const outcome = await settled(
      ctx.poll(
        () =>
          new Promise<string>((resolve) => {
            releaseLate = () => resolve("late");
          }),
        { timeout: 100, interval: 10 },
      ),
    );
    releaseLate();
    expect(outcome).toBeInstanceOf(PollTimeoutError);
  });

  it("does not take another attempt once waiting the interval would pass the timeout", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    let calls = 0;
    const outcome = await settled(
      ctx.poll(
        async () => {
          calls += 1;
          return calls >= 2 ? "late" : undefined;
        },
        { timeout: 80, interval: 500 },
      ),
    );
    expect(outcome).toBeInstanceOf(PollTimeoutError);
    expect(calls).toBe(1);
  });

  it("times out a fn that never settles", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    const outcome = await settled(ctx.poll(() => new Promise(() => {}), { timeout: 120, interval: 20 }));
    expect(outcome).toBeInstanceOf(PollTimeoutError);
  });

  it("ends when timeout is NaN, before calling fn", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    let calls = 0;
    const outcome = await settled(
      ctx.poll(
        async () => {
          calls += 1;
          return undefined;
        },
        { timeout: Number.NaN, interval: 20 },
      ),
    );
    expect(outcome).toBeInstanceOf(InvalidPollOptionsError);
    expect(calls).toBe(0);
  });

  it("ends when interval is NaN, before calling fn", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    let calls = 0;
    const outcome = await settled(
      ctx.poll(
        async () => {
          calls += 1;
          return undefined;
        },
        { timeout: 5_000, interval: Number.NaN },
      ),
    );
    expect(outcome).toBeInstanceOf(InvalidPollOptionsError);
    expect(calls).toBe(0);
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
    const outcome = await settled(
      ctx.poll(async () => {
        calls += 1;
        return "ready";
      }, options),
    );
    expect(outcome).toBeInstanceOf(InvalidPollOptionsError);
    expect(calls).toBe(0);
  });

  it("records timed_out, not a late rejection, when fn never settles and then rejects", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    let rejectLate: (error: Error) => void = () => {};
    const outcome = await settled(
      ctx.poll(
        () =>
          new Promise<undefined>((_resolve, reject) => {
            rejectLate = reject;
          }),
        { timeout: 40, interval: 10 },
      ),
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

// Resolves with the poll's value or the error it rejected with. A poll that
// never settles is left to the test's own timeout.
async function settled(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    (value) => value,
    (error: unknown) => error,
  );
}

// Responsibility: what `pollWithRecording` hands `onFinish` on each way a
// poll can end, called directly rather than through `ctx.poll`.
describe("pollWithRecording: onFinish", () => {
  it("reports resolved with the attempt count for a poll that eventually resolves", async () => {
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
    );
    expect(value).toBe("ready");
    expect(finished?.attempts).toBe(3);
    expect(finished?.outcome).toBe("resolved");
  });

  it("reports failed when fn throws, and the throw propagates unchanged", async () => {
    const boom = new Error("boom from fn");
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
      ),
    ).rejects.toBe(boom);
    expect(finished?.outcome).toBe("failed");
  });

  it("reports timed_out with the attempts made before the timeout", async () => {
    let finished: PollOutcome | undefined;
    await expect(
      pollWithRecording(
        async () => undefined,
        { timeout: 20, interval: 5 },
        (outcome) => {
          finished = outcome;
        },
      ),
    ).rejects.toBeInstanceOf(PollTimeoutError);
    expect(finished?.attempts).toBeGreaterThan(0);
    expect(finished?.outcome).toBe("timed_out");
  });

  // A fake clock, so waitedMs is the budget itself and not whatever a loaded
  // machine stretched it to.
  it("reports one timed_out attempt, waiting exactly the budget, when fn has not settled by it", async () => {
    vi.useFakeTimers();
    try {
      let finished: PollOutcome | undefined;
      const outcome = settled(
        pollWithRecording(
          () => new Promise(() => {}),
          { timeout: 40, interval: 10 },
          (result) => {
            finished = result;
          },
        ),
      );
      await vi.advanceTimersByTimeAsync(40);
      expect(await outcome).toBeInstanceOf(PollTimeoutError);
      expect(finished?.attempts).toBe(1);
      expect(finished?.outcome).toBe("timed_out");
      expect(finished?.waitedMs).toBe(40);
    } finally {
      vi.useRealTimers();
    }
  });
});
