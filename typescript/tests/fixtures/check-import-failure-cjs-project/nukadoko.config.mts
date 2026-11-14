import { defineConfig } from "./nukadoko-shim.mjs";

// .mts, not .ts: this fixture's own package.json has no "type": "module",
// so nukadoko.config.ts would fail to load for the exact reason this
// fixture exists to exercise for a step file instead (see
// features/steps/probe.ts's own comment). nukadoko-shim.mts (imported
// here as .mjs, the same extension-mapping tsx already does for .ts/.js)
// is .mts for the identical reason: a plain .ts shim would fail to load
// under this project's own CommonJS module kind too, which would mask the
// one .ts failure this fixture exists to produce.
export default defineConfig({});
