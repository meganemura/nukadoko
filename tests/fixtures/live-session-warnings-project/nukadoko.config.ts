import { defineConfig, defineFixtures } from "./nukadoko-shim.js";

// `stateDir: "s"` keeps the live session's socket path short, as in
// tests/fixtures/live-session-project. The `broken` environment has a
// version probe that throws, and `brokenTeardown` throws after its own
// `use()` resolves, so a live session has a probe failure to warn about on
// `do` and a teardown failure to report on `stop`.
export default defineConfig({
  baseURL: "http://127.0.0.1:1",
  stateDir: "s",
  environments: {
    broken: {
      version: () => {
        throw new Error("probe boom");
      },
    },
  },
  fixtures: defineFixtures({
    brokenTeardown: async ({}, use) => {
      await use({ id: "t1" });
      throw new Error("brokenTeardown's own teardown exploded on purpose");
    },
  }),
});
