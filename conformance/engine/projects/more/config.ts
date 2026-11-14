import { defineConfig, defineFixtures } from "nukadoko";

export default defineConfig({
  fixtures: defineFixtures({
    store: async ({}, use) => { await use(new Set<string>()); },
    shared: [async ({ store }, use) => { await use(store); }, { scope: "process" }],
    left: async ({ right }, use) => { await use(right); },
    right: async ({ left }, use) => { await use(left); },
  }),
});

declare module "nukadoko" {
  interface StepFixtures {
    store: Set<string>;
    shared: Set<string>;
    left: unknown;
    right: unknown;
  }
}
