import { defineConfig } from "./nukadoko-shim.js";

// tests/check-compat.test.ts's fixture for `nuka check`'s compat-aware
// behavior (m2a-compat-registry task spec, item 6): compat participates in
// undefined-step/duplicate/ambiguous detection across kind, and Then-
// position compat gets a soft warning. A compat-origin defineParameterType
// shares one registry with this config-origin entry (no name collision
// here — see check-compat-parameter-type-collision-project for the
// colliding case); listing that registration as its own finding is now
// `nuka tend`'s job (m8d-move-to-tend task spec), so
// tests/tend-moved-findings.test.ts reuses this same fixture too.
export default defineConfig({
  parameterTypes: [{ name: "shout-config", regexp: /[A-Z]+/ }],
});
