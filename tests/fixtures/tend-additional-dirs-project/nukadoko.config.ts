import { defineConfig } from "./nukadoko-shim.js";

// tests/scan-dirs.test.ts's fixture (fb3-scan-dirs task spec): `accepted/`
// binds inspect-widget.ts's only pattern and is deliberately outside
// `featuresDir` (skills/acceptance/SKILL.md's own recommendation for an
// accepted feature) — `additionalFeatureDirs` is what keeps `nuka tend`'s
// pattern-unbound from misreporting that step as unbound. `ghost-dir` is
// named but never created on disk, to exercise
// `additional-feature-dir-missing` in both `nuka check` and `nuka tend`.
export default defineConfig({
  additionalFeatureDirs: ["accepted", "ghost-dir"],
});
