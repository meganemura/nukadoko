import { defineConfig } from "./nukadoko-shim.js";

// tests/scan-dirs.test.ts's fixture:
// no `additionalFeatureDirs` — `features/accepted-inside.feature` is under
// the default `featuresDir` (scanned), `elsewhere/accepted-outside.feature`
// is not named by any scanned directory. Both get accepted at test runtime;
// only the second should produce a `signed-feature-unscanned` note.
export default defineConfig({});
