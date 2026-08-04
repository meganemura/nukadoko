import { defineConfig } from "./nukadoko-shim.js";

// tests/scan-dirs.test.ts's own regression fixture (fb3-scan-dirs task
// spec): the identical step/feature layout as
// tests/fixtures/tend-additional-dirs-project, minus `additionalFeatureDirs`
// — proves pattern-unbound still fires for inspect-widget.ts exactly as it
// did before additionalFeatureDirs existed, i.e. the unset default changes
// nothing.
export default defineConfig({});
