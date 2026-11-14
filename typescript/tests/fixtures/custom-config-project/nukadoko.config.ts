import { defineConfig } from "./nukadoko-shim.js";

// Proves the loader honors an explicit featuresDir/stateDir instead of
// only ever falling back to the defaults.
export default defineConfig({
  featuresDir: "bdd",
  stateDir: ".state",
});
