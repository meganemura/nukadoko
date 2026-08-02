import { describe, expect, it } from "vitest";
import { After, Before, getRegisteredHooks } from "../src/compat/hooks.js";

// Responsibility: unit coverage for src/compat/hooks.ts's registration shapes
// (m2.1a-compat-registration task spec, decision 1) — in particular the bare
// tag-expression-string form (`Before("@tag", fn)` / `After("not @tag", fn)`)
// that cucumber-js accepts and compat previously silently misread as the
// options form, dropping the tag condition entirely. `getRegisteredHooks()`
// never drains (see hooks.ts's own header), so every assertion here reads
// only the entries this test itself just pushed, off the buffer's tail —
// other tests in this file (and this module's own state, shared for the
// whole file) keep adding to the same buffer.

function lastHook() {
  const hooks = getRegisteredHooks();
  return hooks[hooks.length - 1]!;
}

describe("Before/After hook registration", () => {
  it("Before(fn) registers with tags undefined", () => {
    const fn = () => {};
    Before(fn);
    expect(lastHook()).toMatchObject({ type: "before", tags: undefined, fn });
  });

  it("Before({ tags }, fn) registers with the given tags", () => {
    const fn = () => {};
    Before({ tags: "@smoke" }, fn);
    expect(lastHook()).toMatchObject({ type: "before", tags: "@smoke", fn });
  });

  it('Before("@tag", fn) registers the same as Before({ tags: "@tag" }, fn)', () => {
    const fn = () => {};
    Before("@smoke", fn);
    expect(lastHook()).toMatchObject({ type: "before", tags: "@smoke", fn });
  });

  it('Before("not @tag", fn) registers the same as Before({ tags: "not @tag" }, fn)', () => {
    const fn = () => {};
    Before("not @slow", fn);
    expect(lastHook()).toMatchObject({ type: "before", tags: "not @slow", fn });
  });

  it("After(fn) registers with tags undefined", () => {
    const fn = () => {};
    After(fn);
    expect(lastHook()).toMatchObject({ type: "after", tags: undefined, fn });
  });

  it("After({ tags }, fn) registers with the given tags", () => {
    const fn = () => {};
    After({ tags: "@smoke" }, fn);
    expect(lastHook()).toMatchObject({ type: "after", tags: "@smoke", fn });
  });

  it('After("@tag", fn) registers the same as After({ tags: "@tag" }, fn)', () => {
    const fn = () => {};
    After("@smoke", fn);
    expect(lastHook()).toMatchObject({ type: "after", tags: "@smoke", fn });
  });

  it('After("not @tag", fn) registers the same as After({ tags: "not @tag" }, fn)', () => {
    const fn = () => {};
    After("not @slow", fn);
    expect(lastHook()).toMatchObject({ type: "after", tags: "not @slow", fn });
  });

  // m21b-compat-execution task spec, item 1: `HookOptions.timeout` (14
  // real-world call sites, 3 repos, previously silently dropped — the same
  // "実装方針を揃える" gate src/compat/registry.ts's own `CompatStepOptions`
  // already has for steps).

  it("Before({ timeout }, fn) keeps timeoutMs, tags undefined", () => {
    const fn = () => {};
    Before({ timeout: 5000 }, fn);
    expect(lastHook()).toMatchObject({ type: "before", tags: undefined, timeoutMs: 5000, fn });
  });

  it("Before({ tags, timeout }, fn) keeps both", () => {
    const fn = () => {};
    Before({ tags: "@smoke", timeout: 1000 }, fn);
    expect(lastHook()).toMatchObject({ type: "before", tags: "@smoke", timeoutMs: 1000, fn });
  });

  it("After({ timeout }, fn) keeps timeoutMs the same way Before does", () => {
    const fn = () => {};
    After({ timeout: 2000 }, fn);
    expect(lastHook()).toMatchObject({ type: "after", tags: undefined, timeoutMs: 2000, fn });
  });

  it("Before(fn) (no options at all) leaves timeoutMs undefined", () => {
    const fn = () => {};
    Before(fn);
    expect(lastHook().timeoutMs).toBeUndefined();
  });

  it("an unknown options key throws, naming the key", () => {
    expect(() => Before({ retries: 3 } as never, () => {})).toThrow(/retries/);
  });

  it("an unknown options key throws for After too", () => {
    expect(() => After({ retries: 3 } as never, () => {})).toThrow(/retries/);
  });

  it("a non-object options argument (array) throws", () => {
    expect(() => Before([] as never, () => {})).toThrow();
  });

  it("a non-object options argument (null) throws", () => {
    expect(() => Before(null as never, () => {})).toThrow();
  });
});
