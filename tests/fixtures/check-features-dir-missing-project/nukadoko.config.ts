import { defineConfig } from "./nukadoko-shim.js";

// Deliberately has no `features/` directory anywhere under this fixture:
// proves `nuka check`'s one config-coherence *error* ("featuresDir 不在 =
// エラー", this task's spec item 5) fires, with `nuka check` still able to
// run to completion (an empty vocabulary and an empty feature list are both
// valid, if unhelpful, answers — see discover-steps.ts/load-features.ts).
export default defineConfig({});
