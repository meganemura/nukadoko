import { describe, expect, it } from "vitest";
import { inferNeeds } from "../src/step/infer-needs.js";

// Responsibility: unit tests for src/step/infer-needs.ts's pure scan, run
// in-process against plain functions — the
// same "in-memory first" split tests/fixture-names.test.ts's own header
// established, with the end-to-end path (a real, un-migrated step read
// through `nuka steps --json`, including the required ground-truth
// regression) covered separately in tests/needs-inferred.test.ts.

const KNOWN = new Set(["page", "section", "env"]);

describe("inferNeeds", () => {
  it("reads a plain member access (name.member)", () => {
    const fn = (ctx: { page: unknown }) => {
      void ctx.page;
    };
    expect(inferNeeds(fn, "ctx", KNOWN)).toEqual(["page"]);
  });

  it("reads an optional-chained member access (name?.member)", () => {
    const fn = (ctx: { page?: unknown }) => {
      void ctx?.page;
    };
    expect(inferNeeds(fn, "ctx", KNOWN)).toEqual(["page"]);
  });

  it("reads a mid-body destructuring alias (const { a, b } = name)", () => {
    const fn = (ctx: { page: unknown; section: unknown }) => {
      const { page, section } = ctx;
      void page;
      void section;
    };
    expect(inferNeeds(fn, "ctx", KNOWN)).toEqual(["page", "section"]);
  });

  it("does not read a member access inside a string literal (the one measured false positive)", () => {
    const fn = () => {
      const note = "see ctx.page for details";
      void note;
    };
    expect(inferNeeds(fn, "ctx", KNOWN)).toEqual([]);
  });

  it("does not read a member access inside a template literal", () => {
    const fn = () => {
      const note = `see ctx.page for details`;
      void note;
    };
    expect(inferNeeds(fn, "ctx", KNOWN)).toEqual([]);
  });

  it("does not read a member access inside a comment", () => {
    const fn = () => {
      // ctx.page is mentioned here, in a comment only
      return 1;
    };
    expect(inferNeeds(fn, "ctx", KNOWN)).toEqual([]);
  });

  it("filters out a member that is not a known fixture name", () => {
    const fn = (ctx: { page: unknown; someHelper: () => void }) => {
      void ctx.page;
      ctx.someHelper();
    };
    expect(inferNeeds(fn, "ctx", KNOWN)).toEqual(["page"]);
  });

  it("sorts the result alphabetically", () => {
    const fn = (ctx: { section: unknown; page: unknown; env: unknown }) => {
      void ctx.section;
      void ctx.page;
      void ctx.env;
    };
    expect(inferNeeds(fn, "ctx", KNOWN)).toEqual(["env", "page", "section"]);
  });

  it("returns [] (attempted, nothing found), not undefined, when the body never touches the first argument", () => {
    const fn = (ctx: unknown) => {
      void ctx;
    };
    expect(inferNeeds(fn, "ctx", KNOWN)).toEqual([]);
  });

  it("returns undefined when firstArgumentName is not a plain identifier — nothing to scan by", () => {
    const fn = () => {};
    expect(inferNeeds(fn, "ctx = {}", KNOWN)).toBeUndefined();
    expect(inferNeeds(fn, "", KNOWN)).toBeUndefined();
  });

  it("does not chase an alias for the first argument (documented miss)", () => {
    const fn = (ctx: { page: unknown }) => {
      const c = ctx;
      void c.page;
    };
    expect(inferNeeds(fn, "ctx", KNOWN)).toEqual([]);
  });
});
