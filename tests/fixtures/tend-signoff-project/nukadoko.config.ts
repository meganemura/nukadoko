import { defineConfig } from "./nukadoko-shim.js";

// tests/signoff-rot.test.ts's fixture: a pure-step, no-server project (same
// reasoning as tests/fixtures/accept-project) whose only job is producing a
// real `nuka accept` record for that test file to then stale out in the
// four ways src/tend/signoff-rot.ts's finding checks for. Mixes one typed step
// with one compat step so a healthy record's compat step record (`result:
// null`) is present to prove it never trips the returns-schema check.
// `checkout.feature` itself lives under `elsewhere/`, outside the default
// `featuresDir` ("features") — src/tend/signoff-rot.ts skips every one of
// its own checks for a record whose feature lives inside `featuresDir`, so
// a fixture meant to exercise those checks has to sit outside it.
export default defineConfig({});
