import { defineConfig } from "./nukadoko-shim.js";

// A migrated suite's cucumber.js `worldParameters` (or `--world-parameters`)
// lives here. The step below reads `this.parameters` and fails unless this
// object arrived unchanged.
export default defineConfig({
  worldParameters: {
    baseUrl: "http://example.test",
    retries: 2,
  },
});
