import { describe, expect, it } from "vitest";
import {
  FixtureTimeoutError,
  FixtureUseCalledTwiceError,
  FixtureUseNotCalledError,
  startFixture,
} from "../src/fixture/lifecycle.js";
import type { FixtureFn } from "../src/fixture/types.js";

// Responsibility: unit tests for src/fixture/lifecycle.ts's `startFixture` —
// the use()-suspend/teardown-resume coroutine P5's own "前提" says has to be
// reimplemented from scratch (Playwright's own fixture runtime cannot be
// borrowed). Covers this task's own completion conditions 2-4: teardown
// runs on step failure, use()'s return value carries the outcome, and a
// fixture that never calls use() fails loudly (never hangs) rather than
// timing out silently.

function deps(): any {
  return {};
}

describe("startFixture: normal setup + teardown", () => {
  it("resolves with the value passed to use()", async () => {
    const fn: FixtureFn = async ({}, use) => {
      await use({ id: "t1" });
    };
    const instance = await startFixture("tenant", fn, deps(), 1_000);
    expect(instance.value).toEqual({ id: "t1" });
  });

  it("passes use()'s own return value (the outcome) back into the fixture's own teardown code", async () => {
    let seenOutcome: string | undefined;
    const fn: FixtureFn = async ({}, use) => {
      const outcome = await use(1);
      seenOutcome = outcome;
    };
    const instance = await startFixture("x", fn, deps(), 1_000);
    const error = await instance.teardown("passed");
    expect(error).toBeUndefined();
    expect(seenOutcome).toBe("passed");
  });

  it("runs teardown code even when the outcome is 'failed'", async () => {
    let torndown = false;
    const fn: FixtureFn = async ({}, use) => {
      const outcome = await use(1);
      if (outcome === "failed") {
        torndown = true;
      }
    };
    const instance = await startFixture("x", fn, deps(), 1_000);
    await instance.teardown("failed");
    expect(torndown).toBe(true);
  });

  it("a fixture that conditionally skips its own cleanup on failure (spec's own example) actually skips it", async () => {
    let cleaned = false;
    const fn: FixtureFn = async ({}, use) => {
      const outcome = await use({ id: "t1" });
      if (outcome === "passed") {
        cleaned = true;
      }
    };
    const instance = await startFixture("tenant", fn, deps(), 1_000);
    await instance.teardown("failed");
    expect(cleaned).toBe(false);
  });
});

describe("startFixture: use() contract violations", () => {
  it("throws FixtureUseNotCalledError when the function returns without calling use()", async () => {
    const fn: FixtureFn = async () => {
      // never calls use()
    };
    await expect(startFixture("bad", fn, deps(), 1_000)).rejects.toBeInstanceOf(FixtureUseNotCalledError);
  });

  it("names the fixture in the use-not-called error", async () => {
    const fn: FixtureFn = async () => {};
    await expect(startFixture("bad-one", fn, deps(), 1_000)).rejects.toThrow(/bad-one/);
  });

  it("surfaces the fixture's own thrown error, not a generic use-not-called one, when it throws before calling use()", async () => {
    const fn: FixtureFn = async () => {
      throw new Error("boom during setup");
    };
    await expect(startFixture("bad", fn, deps(), 1_000)).rejects.toThrow("boom during setup");
  });

  it("throws FixtureUseCalledTwiceError, caught as a teardown error, when a fixture calls use() twice", async () => {
    const fn: FixtureFn = async ({}, use) => {
      await use(1);
      await use(2);
    };
    const instance = await startFixture("twice", fn, deps(), 1_000);
    const error = await instance.teardown("passed");
    expect(error).toBeDefined();
    expect(error).toContain("more than once");
  });
});

describe("startFixture: timeout", () => {
  it("throws FixtureTimeoutError, naming the fixture and phase, when use() is never called in time", async () => {
    const fn: FixtureFn = () =>
      new Promise(() => {
        // never resolves, never calls use()
      });
    await expect(startFixture("stuck", fn, deps(), 20)).rejects.toMatchObject({
      fixture: "stuck",
      phase: "setup",
    });
  });

  it("is an instance of FixtureTimeoutError", async () => {
    const fn: FixtureFn = () => new Promise(() => {});
    await expect(startFixture("stuck", fn, deps(), 20)).rejects.toBeInstanceOf(FixtureTimeoutError);
  });

  it("times out teardown, naming the phase, when the code after use() never finishes", async () => {
    const fn: FixtureFn = async ({}, use) => {
      await use(1);
      await new Promise(() => {
        // teardown never finishes
      });
    };
    const instance = await startFixture("slow-teardown", fn, deps(), 20);
    const error = await instance.teardown("passed");
    expect(error).toContain("timed out during teardown");
  });
});

describe("startFixture: teardown throw is caught, never rejects", () => {
  it("returns the error message instead of throwing when teardown code itself throws", async () => {
    const fn: FixtureFn = async ({}, use) => {
      await use(1);
      throw new Error("cleanup failed");
    };
    const instance = await startFixture("x", fn, deps(), 1_000);
    const error = await instance.teardown("passed");
    expect(error).toBe("cleanup failed");
  });
});
