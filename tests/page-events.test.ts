import { describe, expect, it } from "vitest";
import { createPageEventsCollector } from "../src/context/page-events.js";

// Responsibility: PageEventsCollector's own contract in isolation (P0-page-
// events task spec, item 7: "コレクタ単体: 3 種の記録、reset()、上限と
// truncated") — the one part of this task that a real browser is a poor way
// to prove, since the truncation case needs 101+ events in one category and
// a real browser producing that many is slow and, at that volume, likely
// flaky. The step-record-level shape (field omission, redaction, both `nuka do`
// and `nuka run` reaching it) is instead proven end to end, through a real
// browser, in tests/page-events-step-record.test.ts.

describe("PageEventsCollector", () => {
  it("snapshot() is undefined when nothing was ever recorded", () => {
    const collector = createPageEventsCollector();
    expect(collector.snapshot()).toBeUndefined();
  });

  it("records a console error with its text, location, and a fresh at", () => {
    const collector = createPageEventsCollector();
    const before = Date.now();
    collector.recordConsoleError({
      text: "boom",
      location: { url: "https://example.com/app.js", lineNumber: 12, columnNumber: 3 },
    });
    const after = Date.now();

    const snapshot = collector.snapshot();
    expect(snapshot?.page_errors).toBeUndefined();
    expect(snapshot?.failed_requests).toBeUndefined();
    const consoleErrors = snapshot?.console_errors as
      | Array<{ text: string; location: unknown; at: string }>
      | undefined;
    expect(consoleErrors).toEqual([
      {
        text: "boom",
        location: { url: "https://example.com/app.js", lineNumber: 12, columnNumber: 3 },
        at: expect.any(String),
      },
    ]);
    const at = Date.parse(consoleErrors![0]!.at);
    expect(Number.isNaN(at)).toBe(false);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  it("records an uncaught page error by its message alone", () => {
    const collector = createPageEventsCollector();
    collector.recordPageError("ReferenceError: x is not defined");

    const snapshot = collector.snapshot();
    expect(snapshot?.console_errors).toBeUndefined();
    expect(snapshot?.failed_requests).toBeUndefined();
    const pageErrors = snapshot?.page_errors as Array<{ message: string; at: string }> | undefined;
    expect(pageErrors).toHaveLength(1);
    expect(pageErrors![0]!.message).toBe("ReferenceError: x is not defined");
    expect(Number.isNaN(Date.parse(pageErrors![0]!.at))).toBe(false);
  });

  it("records a failed request's method/url/failure, and omits failure when there isn't one", () => {
    const collector = createPageEventsCollector();
    collector.recordFailedRequest({
      method: "GET",
      url: "http://127.0.0.1:1/",
      failure: "net::ERR_CONNECTION_REFUSED",
    });
    collector.recordFailedRequest({ method: "POST", url: "http://127.0.0.1:1/no-failure" });

    const snapshot = collector.snapshot();
    const failedRequests = snapshot?.failed_requests as
      | Array<{ method: string; url: string; failure?: string; at: string }>
      | undefined;
    expect(failedRequests).toHaveLength(2);
    expect(failedRequests![0]).toMatchObject({
      method: "GET",
      url: "http://127.0.0.1:1/",
      failure: "net::ERR_CONNECTION_REFUSED",
    });
    expect(failedRequests![1]).not.toHaveProperty("failure");
  });

  it("reset() clears every category back to undefined", () => {
    const collector = createPageEventsCollector();
    collector.recordConsoleError({ text: "a", location: { url: "", lineNumber: 0, columnNumber: 0 } });
    collector.recordPageError("b");
    collector.recordFailedRequest({ method: "GET", url: "http://127.0.0.1:1/" });
    expect(collector.snapshot()).not.toBeUndefined();

    collector.reset();

    expect(collector.snapshot()).toBeUndefined();
  });

  it("keeps a bare array of all entries up to the 100-entry cap, with no total/truncated", () => {
    const collector = createPageEventsCollector();
    for (let i = 0; i < 100; i += 1) {
      collector.recordPageError(`error ${i}`);
    }

    const snapshot = collector.snapshot();
    const pageErrors = snapshot?.page_errors;
    expect(Array.isArray(pageErrors)).toBe(true);
    expect(pageErrors).toHaveLength(100);
    // Exactly at the cap is not truncation: nothing was ever dropped.
    expect(snapshot?.truncated).toBeUndefined();
  });

  it("truncates at 100 entries per category, stays a bare array, and reports the true total on the sibling truncated field", () => {
    const collector = createPageEventsCollector();
    for (let i = 0; i < 101; i += 1) {
      collector.recordPageError(`error ${i}`);
    }

    const snapshot = collector.snapshot();
    // The category itself never changes shape once truncated (fix-union
    // task spec, item 2): still a bare array, capped at 100, never
    // `{ entries, total, truncated }`.
    expect(Array.isArray(snapshot?.page_errors)).toBe(true);
    expect(snapshot?.page_errors).toHaveLength(100);
    // The true total (101, not the 100 entries shown) lives on the
    // snapshot's own sibling `truncated` field instead.
    expect(snapshot?.truncated).toEqual({ page_errors: 101 });
  });

  it("caps each category independently: one truncated category leaves another's bare array alone, and truncated names only the one that hit the cap", () => {
    const collector = createPageEventsCollector();
    for (let i = 0; i < 101; i += 1) {
      collector.recordPageError(`error ${i}`);
    }
    collector.recordConsoleError({ text: "one", location: { url: "", lineNumber: 0, columnNumber: 0 } });

    const snapshot = collector.snapshot();
    expect(Array.isArray(snapshot?.page_errors)).toBe(true);
    expect(snapshot?.page_errors).toHaveLength(100);
    expect(Array.isArray(snapshot?.console_errors)).toBe(true);
    expect(snapshot?.console_errors).toHaveLength(1);
    // Only the truncated category is named here; the untruncated one has no
    // entry at all, not even a falsy one.
    expect(snapshot?.truncated).toEqual({ page_errors: 101 });
  });

  it("truncated is absent entirely when no category was ever truncated", () => {
    const collector = createPageEventsCollector();
    collector.recordConsoleError({ text: "one", location: { url: "", lineNumber: 0, columnNumber: 0 } });
    collector.recordPageError("b");
    collector.recordFailedRequest({ method: "GET", url: "http://127.0.0.1:1/" });

    const snapshot = collector.snapshot();
    expect(snapshot?.truncated).toBeUndefined();
    expect(Object.keys(snapshot ?? {})).not.toContain("truncated");
  });

  it("truncated lists every truncated category when more than one hits the cap", () => {
    const collector = createPageEventsCollector();
    for (let i = 0; i < 101; i += 1) {
      collector.recordPageError(`error ${i}`);
      collector.recordFailedRequest({ method: "GET", url: `http://127.0.0.1:1/${i}` });
    }

    const snapshot = collector.snapshot();
    expect(snapshot?.truncated).toEqual({ page_errors: 101, failed_requests: 101 });
    expect(snapshot?.truncated).not.toHaveProperty("console_errors");
  });
});
