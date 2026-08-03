import { describe, expect, it } from "vitest";
import { AfterAll, BeforeAll, getRegisteredRunHooks } from "../src/compat/run-hooks.js";

// Responsibility: unit coverage for src/compat/run-hooks.ts's registration
// shapes (m22-compat-run-scope task spec, item 2) — the same registration-
// buffer conventions tests/compat-hooks.test.ts already covers for Before/
// After, minus `tags` (a run-scope hook doesn't accept one at all — see
// run-hooks.ts's own header). `getRegisteredRunHooks()` never drains (same
// contract as `getRegisteredHooks()`), so every assertion here reads only
// the entries this test itself just pushed, off the buffer's tail.

function lastRunHook() {
  const hooks = getRegisteredRunHooks();
  return hooks[hooks.length - 1]!;
}

describe("BeforeAll/AfterAll registration", () => {
  it("BeforeAll(fn) registers with timeoutMs undefined", () => {
    const fn = () => {};
    BeforeAll(fn);
    expect(lastRunHook()).toMatchObject({ type: "beforeAll", fn });
    expect(lastRunHook().timeoutMs).toBeUndefined();
  });

  it("BeforeAll({ timeout }, fn) keeps timeoutMs", () => {
    const fn = () => {};
    BeforeAll({ timeout: 5000 }, fn);
    expect(lastRunHook()).toMatchObject({ type: "beforeAll", timeoutMs: 5000, fn });
  });

  it("AfterAll(fn) registers with timeoutMs undefined", () => {
    const fn = () => {};
    AfterAll(fn);
    expect(lastRunHook()).toMatchObject({ type: "afterAll", fn });
    expect(lastRunHook().timeoutMs).toBeUndefined();
  });

  it("AfterAll({ timeout }, fn) keeps timeoutMs", () => {
    const fn = () => {};
    AfterAll({ timeout: 2000 }, fn);
    expect(lastRunHook()).toMatchObject({ type: "afterAll", timeoutMs: 2000, fn });
  });

  it("registrationOrder increases across BeforeAll and AfterAll calls alike", () => {
    BeforeAll(() => {});
    const first = lastRunHook().registrationOrder;
    AfterAll(() => {});
    const second = lastRunHook().registrationOrder;
    expect(second).toBeGreaterThan(first);
  });

  // This task's spec, item 2: BeforeAll/AfterAll do not accept tags — unlike
  // src/compat/hooks.ts's `HookOptions`, `tags` is not a recognized key here
  // at all, so it throws the same way any other unrecognized key would.
  it('an options object with "tags" throws, naming it as unsupported', () => {
    expect(() => BeforeAll({ tags: "@smoke" } as never, () => {})).toThrow(/tags/);
  });

  it("an unknown options key throws, naming the key", () => {
    expect(() => BeforeAll({ retries: 3 } as never, () => {})).toThrow(/retries/);
  });

  it("an unknown options key throws for AfterAll too", () => {
    expect(() => AfterAll({ retries: 3 } as never, () => {})).toThrow(/retries/);
  });

  it("a non-object options argument (array) throws", () => {
    expect(() => BeforeAll([] as never, () => {})).toThrow();
  });

  it("a non-object options argument (null) throws", () => {
    expect(() => BeforeAll(null as never, () => {})).toThrow();
  });

  it("BeforeAll({ timeout }, fn) requires a function as its second argument", () => {
    expect(() => BeforeAll({ timeout: 100 } as never, undefined as never)).toThrow();
  });
});
