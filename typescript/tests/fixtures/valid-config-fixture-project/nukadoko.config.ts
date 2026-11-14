import { defineConfig, defineFixtures } from "./nukadoko-shim.js";

// One well-formed config fixture. `nuka check` must not report it.
export default defineConfig({
  fixtures: defineFixtures({
    ok: async ({ request }, use) => {
      await use(request);
    },
  }),
});
