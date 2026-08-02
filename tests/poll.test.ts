import { describe, expect, it } from "vitest";
import { poll, PollTimeoutError } from "../src/index.js";

describe("poll", () => {
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
