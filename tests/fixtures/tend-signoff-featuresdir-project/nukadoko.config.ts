import { defineConfig } from "./nukadoko-shim.js";

// tests/signoff-rot-featuresdir.test.ts's fixture — a pure-step, no-server
// project (default `featuresDir`: "features") whose two feature files exist
// to prove src/tend/signoff-rot.ts's own featuresDir placement skip against
// the one mistake it must not make: "features/inside.feature" is genuinely
// inside `featuresDir` (its sign-off's rot must stay silent),
// "features-extra/near-miss.feature" merely shares a string prefix with it
// (its sign-off's rot must still be reported — a plain `startsWith` would
// wrongly treat it as inside). Both share the one step file under
// features/steps/, since discoverSteps scans `featuresDir` for glue
// regardless of where a feature file itself lives.
export default defineConfig({});
