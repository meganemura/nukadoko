import { describe, expect, it } from "vitest";
import { inferNeeds } from "../src/step/infer-needs.js";
import type { FixtureConsumer } from "../src/step/fixture-names.js";

// Responsibility: tests/infer-needs.test.ts already covers the common
// shapes (member access, optional chaining, destructuring, string/template
// literals, line comments). This file covers the scan states that one
// leaves untouched: block comments, single-quote strings, an escaped quote
// inside a string, and a destructured prop list with a trailing comma:
// each is its own state-machine transition in
// src/step/infer-needs.ts's `stripCommentsAndLiterals`/
// `destructuredPropName`, and a step author can write any one of them.

const KNOWN = new Set(["page", "section", "env"]);

/**
 * `inferNeeds` reads only `fn.toString()` (never calls `fn`). This builds
 * a `FixtureConsumer` whose `.toString()` returns `source` verbatim, for
 * the handful of cases below where the *exact characters* matter (a single
 * quote, an escaped quote, a trailing comma). Writing those directly as
 * real TypeScript source and letting vitest's own esbuild transform run
 * would not do: esbuild re-prints every string literal with double quotes
 * and drops a destructuring pattern's trailing comma, so the transpiled
 * function actually reaching `inferNeeds` at test time would silently stop
 * containing what the test claims to be checking. Confirmed empirically
 * against this project's own transform, not assumed.
 */
function fakeFn(source: string): FixtureConsumer {
  const fn = (() => undefined) as unknown as { toString(): string };
  fn.toString = () => source;
  return fn as unknown as FixtureConsumer;
}

describe("inferNeeds: scan states not covered by tests/infer-needs.test.ts", () => {
  it("does not read a member access inside a block comment", () => {
    const fn = () => {
      /* ctx.page is mentioned here, in a block comment only */
      return 1;
    };
    expect(inferNeeds(fn, "ctx", KNOWN)).toEqual([]);
  });

  it("does not end a block comment early on a lone '*' not followed by '/'", () => {
    const fn = () => {
      /* a lone * here, then ctx.page, before the real close */
      return 1;
    };
    expect(inferNeeds(fn, "ctx", KNOWN)).toEqual([]);
  });

  it("does not read a member access inside a single-quote string", () => {
    const fn = fakeFn("function (ctx) { const note = 'see ctx.page for details'; }");
    expect(inferNeeds(fn, "ctx", KNOWN)).toEqual([]);
  });

  it("treats an escaped quote inside a single-quote string as part of the string, not its end", () => {
    // If the escape were mishandled, the escaped `'` would end the string
    // early, "leaking" the rest of the text (including `ctx.page`) into
    // code and producing a false positive.
    const fn = fakeFn("function (ctx) { const note = 'it\\'s not ctx.page really'; }");
    expect(inferNeeds(fn, "ctx", KNOWN)).toEqual([]);
  });

  it("skips an empty destructured prop from a trailing comma without crashing or inventing a name", () => {
    const fn = fakeFn("function (ctx) { const { page, } = ctx; }");
    expect(inferNeeds(fn, "ctx", KNOWN)).toEqual(["page"]);
  });
});
