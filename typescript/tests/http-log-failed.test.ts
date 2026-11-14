import { describe, expect, it } from "vitest";
import { createHttpLogFailedCollector } from "../src/context/http-log-failed.js";

// Responsibility: HttpLogFailedCollector's own contract in isolation. How
// the count reaches a step record is proven by the page-http-log and
// http-log tests and by the step record tests.

describe("HttpLogFailedCollector", () => {
  it("snapshot() is undefined until a failure is recorded", () => {
    expect(createHttpLogFailedCollector().snapshot()).toBeUndefined();
  });

  it("counts failures and zeroes on reset()", () => {
    const collector = createHttpLogFailedCollector();
    collector.record();
    collector.record();
    expect(collector.snapshot()).toBe(2);
    collector.reset();
    expect(collector.snapshot()).toBeUndefined();
  });
});
