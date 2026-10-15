import { defineConfig, defineFixtures } from "./nukadoko-shim.js";

// A project fixture named like a builtin replaces it: every step that
// destructures `scratch` here gets this object, not the builtin one.
const fixtures = defineFixtures({
  scratch: async ({}, use) => {
    await use({ dir: (prefix: string) => `project-${prefix}` });
  },
});

export default defineConfig({ fixtures });
