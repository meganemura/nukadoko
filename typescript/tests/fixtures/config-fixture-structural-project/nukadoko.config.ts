import { defineConfig, defineFixtures } from "./nukadoko-shim.js";

// Each entry but `ok` is a config fixture `nuka check` must report by name,
// in fixture wording. `beta`'s default is `undefined` on purpose: a
// loader that transforms rather than strips rewrites that to `void 0`, and
// the finding must not quote rewritten text. `ok` is a well-formed fixture in the same
// file, so a neighbor that is fine stays unreported.
export default defineConfig({
  fixtures: defineFixtures({
    beta: async ({ page = undefined }: any, use: any) => {
      void page;
      await use(1);
    },
    alpha: async (deps: any, use: any) => {
      void deps;
      await use(1);
    },
    tenant: async ({ nope }: any, use: any) => {
      void nope;
      await use(1);
    },
    gamma: async ({ ...rest }: any, use: any) => {
      void rest;
      await use(1);
    },
    ok: async ({ request }, use) => {
      await use(request);
    },
  }),
});
