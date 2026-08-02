// Responsibility: the "nukadoko/compat" package surface (docs/spec.md
// "Compat steps (the migration door)") — cucumber-js's commonly used subset,
// enough that switching one import lets an existing suite run on nukadoko's
// harness unchanged. Standing design rule for this module and everything
// that touches it later: a compat asset that works today must not stop
// working because a project adopted nukadoko or moved some other piece
// toward the typed side (docs/spec.md, migration-door rule) — the door
// swings both ways.
//
// v1 scope for this slice (m2a-compat-registry task spec, decision 1):
// `Given`/`When`/`Then` (all the same registration function — see
// registry.ts's own comment) and `defineParameterType`. No placeholders for
// what slice B adds (World, Before/After, setWorldConstructor) — this module
// registers a step's pattern and glue function; it does not run anything.
//
// Kept as a thin re-export of registry.ts, not the buffers' own home:
// src/discover/discover-steps.ts needs to land on the *exact* module
// instance this file's own registrations go into (registry.ts's header
// explains why), by importing "./registry.js" directly via its own relative
// path — that only converges on the same instance as this file's own
// "./registry.js" import if this file does nothing to registry.ts's exports
// beyond re-exporting them verbatim (no wrapping, no re-instantiation).
export { Given, When, Then, defineParameterType } from "./registry.js";
