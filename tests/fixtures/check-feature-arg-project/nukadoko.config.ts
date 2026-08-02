import { defineConfig } from "./nukadoko-shim.js";

// m5b-check-feature-arg task spec: exercises `nuka check [feature]`. Two
// feature files on purpose — `features/inside.feature` (under the default
// featuresDir, walked whenever no argument is given) and
// `acceptance/outside.feature` (deliberately outside it, the way
// docs/spec.md's Sign-off section tells a project to place its acceptance
// features) — each with its own undefined step, so a test can tell which
// one a given `nuka check` invocation actually reported. `unknown-type-step.
// ts` gives this project one binding-check error that has nothing to do
// with either feature file, so a test can confirm binding-check still runs
// when a feature argument narrows which feature gets checked.
export default defineConfig({});
