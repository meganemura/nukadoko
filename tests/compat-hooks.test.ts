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
});
