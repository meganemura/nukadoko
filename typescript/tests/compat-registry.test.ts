import { describe, expect, it } from "vitest";
import { Given, Then, When, drainCompatSteps } from "../src/compat/registry.js";

// Responsibility: unit coverage for src/compat/registry.ts's step
// registration shapes — in
// particular the 3-argument form (`Given(pattern, options, fn)`) that
// cucumber-js accepts and compat previously silently misread as the
// 2-argument form, registering the options object itself as `fn` and
// discarding the real glue function. `drainCompatSteps()` empties the buffer
// on every call (see registry.ts's own header), so each test's own
// `drainCompatSteps()` call returns exactly (and only) what that test itself
// registered.

describe("Given/When/Then step registration", () => {
  it("2-argument Given(pattern, fn) registers fn, timeoutMs undefined", () => {
    const fn = () => {};
    Given("a 2-arg step", fn);
    const [registration] = drainCompatSteps();
    expect(registration).toMatchObject({ keyword: "Given", pattern: "a 2-arg step", fn });
    expect(registration!.timeoutMs).toBeUndefined();
  });

  it("3-argument Given(pattern, { timeout }, fn) registers fn (not the options object) and keeps timeoutMs", () => {
    const fn = () => {};
    Given("a 3-arg step", { timeout: 1000 }, fn);
    const [registration] = drainCompatSteps();
    expect(registration).toMatchObject({
      keyword: "Given",
      pattern: "a 3-arg step",
      fn,
      timeoutMs: 1000,
    });
  });

  it("3-argument When(pattern, { timeout }, fn) works the same as Given", () => {
    const fn = () => {};
    When("a when step", { timeout: 500 }, fn);
    const [registration] = drainCompatSteps();
    expect(registration).toMatchObject({ keyword: "When", fn, timeoutMs: 500 });
  });

  it("3-argument Then(pattern, { timeout }, fn) works the same as Given", () => {
    const fn = () => {};
    Then("a then step", { timeout: 500 }, fn);
    const [registration] = drainCompatSteps();
    expect(registration).toMatchObject({ keyword: "Then", fn, timeoutMs: 500 });
  });

  it("an unknown options key throws, naming the key", () => {
    const fn = () => {};
    expect(() => Given("a step", { retries: 3 } as never, fn)).toThrow(/retries/);
    drainCompatSteps();
  });

  it("an unknown options key's error also names the step's pattern", () => {
    const fn = () => {};
    expect(() => Given("a very specific pattern", { retries: 3 } as never, fn)).toThrow(
      /a very specific pattern/,
    );
    drainCompatSteps();
  });

  it("a non-object options argument (string) throws", () => {
    expect(() => Given("a step", "not an object" as never, (() => {}) as never)).toThrow();
    drainCompatSteps();
  });

  it("a non-object options argument (array) throws", () => {
    expect(() => Given("a step", [] as never, (() => {}) as never)).toThrow();
    drainCompatSteps();
  });

  it("a non-object options argument (null) throws", () => {
    expect(() => Given("a step", null as never, (() => {}) as never)).toThrow();
    drainCompatSteps();
  });

  it("drainCompatSteps() empties the buffer, so a second call returns nothing new", () => {
    Given("one more step", () => {});
    drainCompatSteps();
    expect(drainCompatSteps()).toEqual([]);
  });
});
