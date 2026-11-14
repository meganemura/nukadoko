import { describe, expect, expectTypeOf, it } from "vitest";
import { defineConfig, type FixtureDeps, type UseFn } from "../src/index.js";

// Responsibility: a fixture written inline in defineConfig gets its
// parameter types from the config's own type, in both of the shapes the
// config accepts (a function, and a [function, options] tuple). Under
// `strict`, an untyped parameter is an error (TS7006), and the spec's own
// fixture example failed `tsc` that way: the schema gave the config's
// input no type for a fixture. `npm run typecheck` compiles this file, so
// the assertions below are checked at compile time as well as run.

describe("defineConfig fixtures", () => {
  it("types a bare fixture function's deps and use", () => {
    const config = defineConfig({
      fixtures: {
        bare: async (deps, use) => {
          expectTypeOf(deps).toEqualTypeOf<FixtureDeps>();
          expectTypeOf(use).toEqualTypeOf<UseFn>();
          await use(1);
        },
      },
    });
    expect(typeof config.fixtures?.bare).toBe("function");
  });

  it("types a tuple fixture's deps and use, and keeps its options", () => {
    const config = defineConfig({
      fixtures: {
        tuple: [
          async (deps, use) => {
            expectTypeOf(deps).toEqualTypeOf<FixtureDeps>();
            expectTypeOf(use).toEqualTypeOf<UseFn>();
            await use("packed.tgz");
          },
          { scope: "process" },
        ],
      },
    });
    expect(Array.isArray(config.fixtures?.tuple)).toBe(true);
  });
});
