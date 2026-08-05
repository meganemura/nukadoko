import { describe, expect, it } from "vitest";
import { createHttpOmittedCollector } from "../src/context/http-omitted.js";

// Responsibility: HttpOmittedCollector's own contract in isolation (p3b-
// page-network task spec) — record/snapshot/reset, and the "whole field
// omitted, not merely empty" convention `page_events`'s own collector
// already follows (tests/page-events.test.ts). The receipt-level shape
// (field omission, redaction not needed since only counts are carried, both
// `nuka do` and `nuka run` reaching it) is proven end to end, through a real
// browser, in tests/page-network.test.ts.

describe("HttpOmittedCollector", () => {
  it("snapshot() is undefined when nothing was ever recorded", () => {
    const collector = createHttpOmittedCollector();
    expect(collector.snapshot()).toBeUndefined();
  });

  it("tallies one resourceType per call, and several distinct types side by side", () => {
    const collector = createHttpOmittedCollector();
    collector.record("image");
    collector.record("image");
    collector.record("stylesheet");
    collector.record("script");
    collector.record("image");

    expect(collector.snapshot()).toEqual({ image: 3, stylesheet: 1, script: 1 });
  });

  it("reset() zeroes the tally back to undefined", () => {
    const collector = createHttpOmittedCollector();
    collector.record("image");
    expect(collector.snapshot()).toEqual({ image: 1 });

    collector.reset();

    expect(collector.snapshot()).toBeUndefined();
  });

  it("a snapshot taken mid-run does not share identity with a later one (no aliasing)", () => {
    const collector = createHttpOmittedCollector();
    collector.record("image");
    const first = collector.snapshot();
    collector.record("image");
    const second = collector.snapshot();

    expect(first).toEqual({ image: 1 });
    expect(second).toEqual({ image: 2 });
  });
});
