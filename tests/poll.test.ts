import { describe, expect, expectTypeOf, it } from "vitest";
import { poll, PollTimeoutError } from "../src/index.js";

interface Job {
  id: string;
}

describe("poll", () => {
  it("resolves to T (not T | undefined) for fn: () => Promise<T | undefined>, usable without a cast", async () => {
    const fetchJob = async (): Promise<Job | undefined> => ({ id: "job-1" });
    const job = await poll(fetchJob, { interval: 5, timeout: 50 });
    expectTypeOf(job).toEqualTypeOf<Job>();
    expect(job.id).toBe("job-1");
  });

  it("returns the value once fn stops returning undefined", async () => {
    let calls = 0;
    const value = await poll(
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
    const attempt = poll(async () => undefined, {
      timeout: 30,
      interval: 10,
      description: "widget to become ready",
    });

    await expect(attempt).rejects.toBeInstanceOf(PollTimeoutError);
  });

  it("includes the description in the timeout error message", async () => {
    await expect(
      poll(async () => undefined, {
        timeout: 30,
        interval: 10,
        description: "widget to become ready",
      }),
    ).rejects.toThrow(/widget to become ready/);
  });

  it("omits any 'while ...' clause when no description is given", async () => {
    await expect(poll(async () => undefined, { timeout: 20, interval: 10 })).rejects.toThrow(
      /^poll timed out after 20ms$/,
    );
  });
});
