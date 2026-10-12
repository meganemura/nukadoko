import { defineConfig } from "./nukadoko-shim.js";

// retention.runs is 1 so that a second run is enough to make the run rule
// want to remove the first.
export default defineConfig({ retention: { runs: 1 } });
