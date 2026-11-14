import { defineConfig } from "./nukadoko-shim.js";

// `auto: true` must be refused
// with its own dedicated message, naming why (this is not "Playwright
// fixture compatible" beyond the shape of a definition). `as any` on the
// options object is deliberate — `FixtureOptions`'s own TypeScript type has
// no `auto` member at all, so without it this line would simply fail to
// compile (the same "reach the runtime backstop on purpose" pattern
// tests/fixtures/fixture-bag-project's own unknown-fixture-step.ts already
// uses for the same structural reason). Refused at config *load* time (a
// `ConfigError`, same family as every other structural config mistake
// src/config/schema.ts already refuses), not merely reported by `nuka
// check` — so this config never even reaches discovery.
export default defineConfig({
  fixtures: {
    seededDb: [
      async ({}, use: any) => {
        await use(1);
      },
      { scope: "process", auto: true } as any,
    ],
  },
});
