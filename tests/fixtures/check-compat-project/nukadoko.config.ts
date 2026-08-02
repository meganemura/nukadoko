import { defineConfig } from "./nukadoko-shim.js";

// tests/check-compat.test.ts's fixture for `nuka check`'s compat-aware
// behavior (m2a-compat-registry task spec, item 6): compat participates in
// undefined-step/duplicate/ambiguous detection across kind, Then-position
// compat gets a soft warning, and a compat-origin defineParameterType is
// listed as a warning while sharing one registry with this config-origin
// entry (no name collision here — see check-compat-parameter-type-
// collision-project for the colliding case).
export default defineConfig({
  parameterTypes: [{ name: "shout-config", regexp: /[A-Z]+/ }],
});
