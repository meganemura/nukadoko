import { defineConfig } from "./nukadoko-shim.js";

// tests/signoff-rot.test.ts's fixture: a pure-step, no-server project (same
// reasoning as tests/fixtures/accept-project) whose only job is producing a
// real `nuka accept` record for that test file to then stale out in the
// four ways m8b-tend-signoff-rot's finding checks for. Mixes one typed step
// with one compat step so a healthy record's compat receipt (`result:
// null`) is present to prove it never trips the returns-schema check.
export default defineConfig({});
