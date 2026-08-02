// Responsibility: the "nukadoko/compat" package surface (docs/spec.md
// "Compat steps (the migration door)") — cucumber-js's commonly used subset,
// enough that switching one import lets an existing suite run on nukadoko's
// harness unchanged. Standing design rule for this module and everything
// that touches it later: a compat asset that works today must not stop
// working because a project adopted nukadoko or moved some other piece
// toward the typed side (docs/spec.md, migration-door rule) — the door
// swings both ways.
//
// v1 scope, slice A (m2a-compat-registry task spec, decision 1):
// `Given`/`When`/`Then` (all the same registration function — see
// registry.ts's own comment) and `defineParameterType`. Slice B (m2b-
// compat-execution task spec) adds World/setWorldConstructor, Before/After,
// and DataTable — execution, not just registration.
//
// Kept as a thin re-export of each surface's own module, not their buffers'
// home: src/discover/discover-steps.ts needs to land on the *exact* module
// instance a step file's own registrations/World/hooks go into (registry.ts
// and world.ts's own headers explain why), by importing each one directly
// via its own relative path — that only converges on the same instance as
// this file's own imports if this file does nothing to any of their exports
// beyond re-exporting them verbatim (no wrapping, no re-instantiation).
export { Given, When, Then, defineParameterType } from "./registry.js";
export {
  World,
  setWorldConstructor,
  type WorldConstructor,
  type WorldConstructorParams,
} from "./world.js";
export { Before, After, type HookFn, type HookOptions } from "./hooks.js";
export { DataTable } from "./data-table.js";
