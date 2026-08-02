import { describe, expect, it } from "vitest";
import { getDefaultTimeoutMs, setDefaultTimeout } from "../src/compat/registry.js";

// Responsibility: unit coverage for src/compat/registry.ts's
// `setDefaultTimeout`/`getDefaultTimeoutMs` (m22-compat-run-scope task spec,
// item 1) — a single overwritable value, not a per-file queue like
// `drainCompatSteps`, so "starts undefined" only holds reliably in a test
// file of its own: vitest isolates each test file's own module registry by
// default (vitest.config.ts sets no `isolate: false`), so this file's own
// top-level `import` of registry.ts starts fresh regardless of what any
// other test file in the same run already called — unlike a real discovery
// run's own scoped tsx import (src/discover/discover-steps.ts), which gets
// its own fresh module instance on every `discoverSteps()` call; that
// end-to-end behavior is covered separately in tests/compat-run-scope.test.ts.

describe("setDefaultTimeout / getDefaultTimeoutMs", () => {
  it("is undefined before setDefaultTimeout is ever called", () => {
    expect(getDefaultTimeoutMs()).toBeUndefined();
  });

  it("holds the value passed to setDefaultTimeout", () => {
    setDefaultTimeout(3000);
    expect(getDefaultTimeoutMs()).toBe(3000);
  });

  it("the last call wins when called more than once", () => {
    setDefaultTimeout(1000);
    setDefaultTimeout(2000);
    setDefaultTimeout(500);
    expect(getDefaultTimeoutMs()).toBe(500);
  });
});
