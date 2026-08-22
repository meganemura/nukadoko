import { defineConfig } from "./nukadoko-shim.js";

// tests/feature-never-signed.test.ts's fixture: two features under
// featuresDir ("features") and two more under an additionalFeatureDirs
// entry ("extra"), one of each pair accepted by the test itself (a real
// `nuka run` + `nuka accept`, never a hand-assembled record) and one left
// alone, so the finding under test can be proven both to fire and to stay
// quiet, in both scanned locations, in the same report.
export default defineConfig({
  additionalFeatureDirs: ["extra"],
});
