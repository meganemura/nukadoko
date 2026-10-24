import { defineConfig } from "./nukadoko-shim.js";

// tests/check-notes.test.ts's fixture: `nuka check` must report zero notes
// and zero errors against it: every step has a bound pattern, every schema field is
// described, `from` is exercised for real, and
// there is no `parameterTypes` entry to go unused. The
// `checkout.2026-01-01-abc1234.default.no-browser.md` beside the feature is
// a sign-off record from a release that still had `nuka accept`: it stays
// here so the tests prove such a leftover file is inert.
export default defineConfig({});
