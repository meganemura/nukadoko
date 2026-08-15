import { describe, expect, it } from "vitest";
import { discoverSteps } from "../src/discover/discover-steps.js";
import {
  FixtureDefaultValueError,
  FixtureNotDestructuredError,
  FixtureRestParameterError,
  fixtureParameterNames,
} from "../src/step/fixture-names.js";
import { fixture } from "./helpers/fixtures.js";

// Responsibility: unit tests for src/step/fixture-names.ts's pure
// extraction, plus a required regression test — a
// representative step loaded through the real discovery path (tsx's
// `register().import()`, not a plain in-process function) asserting the
// names extracted from its real, esbuild-transformed `fn.toString()` match
// what was written. The in-process cases below (plain arrow functions
// defined right here) exercise the extraction's own edge cases cheaply,
// the same "in-memory first, one dedicated tsx-loaded test as the guard"
// split tests/validate-from.test.ts's own header established for `from`.

describe("fixtureParameterNames: in-process extraction", () => {
  it("reads every destructured name, in source order", () => {
    const fn = ({ page, section }: { page: unknown; section: unknown }) => {
      void page;
      void section;
    };
    expect(fixtureParameterNames(fn)).toEqual(["page", "section"]);
  });

  it("reads the key name, not the local binding, for a renamed prop", () => {
    const fn = ({ env: environment }: { env: unknown }) => {
      void environment;
    };
    expect(fixtureParameterNames(fn)).toEqual(["env"]);
  });

  it("returns [] for an empty destructuring pattern", () => {
    const fn = ({}: object) => {};
    expect(fixtureParameterNames(fn)).toEqual([]);
  });

  it("returns [] for a function that takes no arguments at all", () => {
    const fn = () => {};
    expect(fixtureParameterNames(fn)).toEqual([]);
  });

  it("memoizes per function reference — a second call returns the same array", () => {
    const fn = ({ poll }: { poll: unknown }) => {
      void poll;
    };
    const first = fixtureParameterNames(fn);
    const second = fixtureParameterNames(fn);
    expect(second).toBe(first);
  });

  it("throws FixtureNotDestructuredError for a bare positional first argument", () => {
    const fn = (ctx: unknown) => {
      void ctx;
    };
    expect(() => fixtureParameterNames(fn)).toThrow(FixtureNotDestructuredError);
  });

  it("throws FixtureDefaultValueError for a destructured prop with a default value", () => {
    const fn = ({ baseURL = "unused" }: { baseURL?: unknown }) => {
      void baseURL;
    };
    expect(() => fixtureParameterNames(fn)).toThrow(FixtureDefaultValueError);
  });

  it("throws FixtureRestParameterError for a rest property", () => {
    const fn = ({ ...rest }: object) => {
      void rest;
    };
    expect(() => fixtureParameterNames(fn)).toThrow(FixtureRestParameterError);
  });
});

describe("fixtureParameterNames: tsx-loaded regression", () => {
  it("reads a representative step's own fixture names through the real tsx discovery path", async () => {
    const { vocabulary } = await discoverSteps(fixture("fixture-bag-project"), "features");
    const entry = vocabulary.get("clean-step");
    expect(entry?.kind).toBe("typed");
    if (entry === undefined || entry.kind !== "typed") {
      throw new Error("unreachable: clean-step should be a typed vocabulary entry");
    }
    // Guards against tsx's own default esbuild transform silently changing
    // fn.toString()'s own shape out from under src/step/fixture-names.ts —
    // this is the one place that dependency is actually exercised.
    expect(fixtureParameterNames(entry.step.run)).toEqual(["page", "env"]);
  });
});
