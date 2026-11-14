import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeVersion } from "../src/environment/probe-version.js";

// Responsibility: probe-version.ts's own success/throw/timeout behavior in
// isolation. The timeout case uses
// vitest's fake timers rather than a real 10s wait: `vi.useFakeTimers()`
// replaces the global `setTimeout` probe-version.ts races against, so
// `vi.advanceTimersByTimeAsync` fires it instantly instead of the test
// actually blocking for the configured budget.

describe("probeVersion", () => {
  it("returns undefined when no probe is configured", async () => {
    const result = await probeVersion(undefined);
    expect(result).toBeUndefined();
  });

  it("resolves ok with the probe's string return value", async () => {
    const result = await probeVersion(() => "1.2.3");
    expect(result).toEqual({ ok: true, version: "1.2.3" });
  });

  it("resolves ok for an async probe", async () => {
    const result = await probeVersion(async () => "9.9.9");
    expect(result).toEqual({ ok: true, version: "9.9.9" });
  });

  it("resolves not-ok, with the thrown message, when the probe throws synchronously", async () => {
    const result = await probeVersion(() => {
      throw new Error("probe boom");
    });
    expect(result).toEqual({ ok: false, reason: "probe boom" });
  });

  it("resolves not-ok when the probe's promise rejects", async () => {
    const result = await probeVersion(async () => {
      throw new Error("async boom");
    });
    expect(result).toEqual({ ok: false, reason: "async boom" });
  });

  it("resolves not-ok when the probe returns a non-string value", async () => {
    const result = await probeVersion((() => 42) as unknown as () => string);
    expect(result).toEqual({ ok: false, reason: "version probe must resolve to a string, got number" });
  });

  describe("timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("resolves not-ok after the configured budget when the probe never settles", async () => {
      const hungProbe = () => new Promise<string>(() => {});
      const resultPromise = probeVersion(hungProbe, 10_000);

      await vi.advanceTimersByTimeAsync(10_000);

      const result = await resultPromise;
      expect(result).toEqual({ ok: false, reason: "version probe timed out after 10000ms" });
    });

    it("does not time out a probe that settles just under the budget", async () => {
      const slowProbe = () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("1.0.0"), 9_000);
        });
      const resultPromise = probeVersion(slowProbe, 10_000);

      await vi.advanceTimersByTimeAsync(9_000);

      const result = await resultPromise;
      expect(result).toEqual({ ok: true, version: "1.0.0" });
    });
  });
});
