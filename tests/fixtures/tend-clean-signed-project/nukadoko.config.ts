import { defineConfig } from "./nukadoko-shim.js";

// tests/tend.test.ts's fixture: the same clean vocabulary
// tests/fixtures/tend-clean-project carries (every step bound, described,
// and carrying a rationale, `from` exercised for real, no unused
// `parameterTypes` entry), plus a static acceptance record beside
// features/checkout.feature, so `nuka tend` reports nothing at all: this is
// the one fixture that is clean on every axis this command checks,
// including the never-signed finding tend-clean-project's own copy of this
// feature now deliberately triggers.
export default defineConfig({});
