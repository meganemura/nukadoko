import { defineConfig } from "./nukadoko-shim.js";

// tests/signoff-condition-mismatch.test.ts's fixture — two browser-touching
// features that are otherwise identical, one accepted inside `featuresDir`
// ("features/inside.feature") and one outside it ("elsewhere/outside.feature"),
// so the same mismatch (config's browserType diverging from a sign-off's own
// recorded one) can be checked both where the note fires and where
// src/tend/signoff-condition-mismatch.ts's own featuresDir skip silences it
// instead. Not shared with tests/fixtures/accept-condition-project (that
// fixture's own "features/browser.feature" lives inside featuresDir on
// purpose, for a different test file, and moving it would ripple into that
// file's own assertions for no reason this task needs).
export default defineConfig({});
