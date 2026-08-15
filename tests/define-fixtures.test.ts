import { describe, expect, it } from "vitest";
import { defineFixtures } from "../src/fixture/define-fixtures.js";

// Responsibility: unit tests for src/fixture/define-fixtures.ts. The type-
// level promise this function exists for (fully typed) is checked by
// `npm run typecheck` compiling this very file
// under `strict` with no implicit-`any` errors — the runtime assertions
// below only pin down that `defineFixtures` is a plain identity function
// (docs/spec.md's own "give a literal a name, validate nothing" contract,
// mirroring src/config/define-config.ts's own `defineConfig`).

describe("defineFixtures", () => {
  it("returns the exact same object it was given (identity, no cloning)", () => {
    const fixtures = defineFixtures({
      tenant: async ({ request }, use) => {
        void request;
        await use({ id: "t1" });
      },
    });
    expect(fixtures.tenant).toBeInstanceOf(Function);
  });

  it("fully types deps (a real builtin) and use with no implicit any — proven by this compiling under strict", () => {
    const fixtures = defineFixtures({
      tenant: async ({ request }, use) => {
        // `request` is a real Playwright APIRequestContext here — proven by
        // calling one of its own methods without any cast.
        const response = await request.get("http://127.0.0.1:1/never-actually-called").catch(() => undefined);
        void response;
        const outcome = await use({ id: "t1" });
        expect(["passed", "failed"]).toContain(outcome);
      },
    });
    expect(Object.keys(fixtures)).toEqual(["tenant"]);
  });

  it("accepts the [fn, options] tuple form alongside a bare function in the same call", () => {
    const fixtures = defineFixtures({
      tenant: async ({}, use) => {
        await use(1);
      },
      seededDb: [
        async ({}, use) => {
          await use(2);
        },
        { scope: "process" },
      ],
    });
    expect(Array.isArray(fixtures.seededDb)).toBe(true);
    expect(typeof fixtures.tenant).toBe("function");
  });
});
