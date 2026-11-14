import { defineConfig } from "./nukadoko-shim.js";

// tests/scan-dirs.test.ts's fixture: `extra/`
// binds inspect-widget.ts's only pattern and is deliberately outside
// `featuresDir`; `additionalFeatureDirs` is what keeps the
// pattern-unbound note from misreporting that step as unbound. `ghost-dir` is
// named but never created on disk, to exercise
// `additional-feature-dir-missing`.
export default defineConfig({
  additionalFeatureDirs: ["extra", "ghost-dir"],
});
