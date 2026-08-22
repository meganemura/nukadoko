import { defineConfig } from "./nukadoko-shim.js";

// Proves loadConfig reads nukadoko.config.mts, not just the .ts name —
// same featuresDir/stateDir override custom-config-project uses for
// nukadoko.config.ts, so the two fixtures assert the identical fact for
// each of the two accepted config file names.
export default defineConfig({
  featuresDir: "bdd",
  stateDir: ".state",
});
