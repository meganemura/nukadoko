import { defineConfig, defineFixtures } from "./nukadoko-shim.js";

// P5 task spec's own completion condition 8: `nuka check` must catch a
// fixture dependency cycle and a scope violation before anything runs —
// every fixture below is structurally broken on purpose and none is
// destructured by any step in this project, since `nuka check` validates
// `config.fixtures` regardless of what a step happens to use (this task's
// spec, scope item 8: "config coherence"-style checking, unconditional).

export default defineConfig({
  fixtures: defineFixtures({
    // A two-node cycle: a depends on b, b depends on a.
    a: async ({ b }: any, use) => {
      void b;
      await use(1);
    },
    b: async ({ a: aValue }: any, use) => {
      void aValue;
      await use(2);
    },
    // A "process"-scope fixture depending on a "scenario"-scope builtin —
    // fixture-scope-violation.
    seededDb: [
      async ({ page }: any, use) => {
        void page;
        await use(3);
      },
      { scope: "process" },
    ],
    // page overridden by a fixture that owns neither page nor context —
    // page-override-unowned.
    page: async ({ request }: any, use) => {
      void request;
      await use({});
    },
  }),
});
