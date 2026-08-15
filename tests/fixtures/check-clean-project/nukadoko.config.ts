import { defineConfig } from "./nukadoko-shim.js";

// A well-formed project, on purpose: `nuka check` must report zero errors
// and zero warnings against it (a clean project exits 0 with zero errors).
// Its one feature file also exercises
// Background merging and Scenario Outline expansion — check delegates that
// expansion to @cucumber/gherkin entirely (docs/spec.md "nukadoko
// deliberately owns as little as possible"); this fixture is not a test of
// gherkin itself, just confirmation that check's own matching runs against
// the pickles gherkin actually produces.
export default defineConfig({});
