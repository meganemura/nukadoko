import { describe, expect, it } from "vitest";
import { runWithTimeout } from "../src/run/run-scenario.js";

// Responsibility: the timeout number `runWithTimeout` actually arms.
// cucumber-js arms a timer only when the value is zero or greater, and a
// negative value means no timeout. That rule is the compat source
// ("registered", this function's default). A typed step passes "step" or
// "config" and has no negative-means-off idiom, so a negative number there
// is still a limit. The setDefaultTimeout(-1) path that reaches this
// function through a real run is tests/compat-run-scope.test.ts.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runWithTimeout: a negative compat timeout means no timeout", () => {
  it("does not time out a step when the registered timeout is negative", async () => {
    const result = await runWithTimeout(async () => {
      await sleep(40);
      return "finished";
    }, -1, "Step", "compat: a slow step");
    expect(result).toBe("finished");
  });

  it("still times out at zero", async () => {
    await expect(
      runWithTimeout(async () => {
        await sleep(200);
        return "finished";
      }, 0, "Step", "compat: a slow step"),
    ).rejects.toThrow("timed out after 0ms");
  });

  it("still times out at a positive value", async () => {
    const startedAt = Date.now();
    await expect(
      runWithTimeout(async () => {
        await sleep(400);
        return "finished";
      }, 30, "Step", "compat: a slow step"),
    ).rejects.toThrow("timed out after 30ms");
    expect(Date.now() - startedAt).toBeLessThan(300);
  });

  it("still times out a typed step whose own timeout is negative", async () => {
    await expect(
      runWithTimeout(
        async () => {
          await sleep(200);
          return "finished";
        },
        -1,
        "Step",
        "typed: a slow step",
        "step",
      ),
    ).rejects.toThrow("timed out after -1ms");
  });
});
