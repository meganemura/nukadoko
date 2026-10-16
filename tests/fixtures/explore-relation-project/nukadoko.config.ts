import { defineConfig, defineFixtures } from "./nukadoko-shim.js";

// `counter` is the system under test: a fresh total for every sequence,
// so the source and the follow each start from zero.
export default defineConfig({
  fixtures: defineFixtures({
    counter: async ({}, use) => {
      await use({ total: 0, adds: 0 });
    },
  }),
});
