import { defineConfig, defineFixtures } from "./nukadoko-shim.js";

// A pure-step project: the one fixture here never touches a browser or the
// network. Its only job is to throw after its own `use()` resolves, so a
// scenario's own teardown phase has something real to report a failure
// about (docs/spec.md "Records": `ScenarioRecord.teardown_errors`).
export default defineConfig({
  fixtures: defineFixtures({
    brokenTeardown: async ({}, use) => {
      await use({ id: "t1" });
      throw new Error("brokenTeardown's own teardown exploded on purpose");
    },
  }),
});
