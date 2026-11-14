import { defineConfig } from "./nukadoko-shim.js";

// featuresDir exists on disk (so
// features-dir-missing does not also fire) but holds nothing discovery can
// import -- only this README, which no walked extension matches. `nuka
// check` must report no-step-files-found and name the directory it walked,
// so a reader can tell the finding is not lying.
export default defineConfig({});
