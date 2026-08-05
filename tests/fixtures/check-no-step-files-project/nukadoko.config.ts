import { defineConfig } from "./nukadoko-shim.js";

// p10-step-discovery task spec, scope 3: featuresDir exists on disk (so
// features-dir-missing does not also fire) but holds nothing discovery can
// import -- only this README, which no walked extension matches. `nuka
// check` must report no-step-files-found and name the directory it walked,
// the same "so a reader can tell a finding isn't lying" reasoning as `nuka
// tend`'s own scanned: line.
export default defineConfig({});
