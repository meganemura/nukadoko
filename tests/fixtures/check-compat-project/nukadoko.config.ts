import { defineConfig } from "./nukadoko-shim.js";

// tests/check-compat.test.ts's fixture for `nuka check`'s compat-aware
// behavior: compat participates in undefined-step/duplicate/ambiguous
// detection across kind, and Then-position compat gets a soft warning. A
// compat-origin defineParameterType shares one registry with this
// config-origin entry (no name collision here — see
// check-compat-parameter-type-collision-project for the colliding case).
export default defineConfig({
  parameterTypes: [{ name: "shout-config", regexp: /[A-Z]+/ }],
});
