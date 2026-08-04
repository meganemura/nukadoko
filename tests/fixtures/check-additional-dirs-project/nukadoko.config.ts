import { defineConfig } from "./nukadoko-shim.js";

// tests/scan-dirs.test.ts's fixture (fb3-scan-dirs task spec, decision 1):
// same layout as tests/fixtures/check-feature-arg-project — `features/
// inside.feature` under featuresDir, `acceptance/outside.feature`
// deliberately outside it — but `additionalFeatureDirs` names `acceptance`,
// so a `nuka check` with no argument must now report `outside.feature`'s
// own undefined step too. `ghost-dir` is named but never created, to
// exercise `additional-feature-dir-missing`.
export default defineConfig({
  additionalFeatureDirs: ["acceptance", "ghost-dir"],
});
