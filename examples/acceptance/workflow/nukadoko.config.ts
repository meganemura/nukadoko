import { defineConfig, defineFixtures } from "nukadoko";
import { createStore, type Store } from "./src/signup.ts";

export default defineConfig({
  fixtures: defineFixtures({
    store: async ({}, use) => { await use(createStore()); },
  }),
});

declare module "nukadoko" {
  interface StepFixtures {
    store: Store;
  }
}
