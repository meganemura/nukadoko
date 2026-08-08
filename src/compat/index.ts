// Responsibility: the "nukadoko/compat" package surface (docs/spec.md
// "Compat steps (the migration door)") — cucumber-js's commonly used subset,
// enough that switching one import lets an existing suite run on nukadoko's
// harness unchanged. Standing design rule for this module and everything
// that touches it later: a compat asset that works today must not stop
// working because a project adopted nukadoko or moved some other piece
// toward the typed side (docs/spec.md, migration-door rule) — the door
// swings both ways.
//
// This surface widened in stages: `Given`/`When`/`Then` (all the same
// registration function — see registry.ts's own comment) and
// `defineParameterType` first; then World/setWorldConstructor, Before/After,
// and DataTable, for execution as well as registration; then
// `setDefaultTimeout` and `BeforeAll`/`AfterAll` — the two most common
// non-exported names that the compat audit found real-world suites hit,
// added together since their owning files mostly overlap with each other's.
//
// Kept as a thin re-export of each surface's own module, not their buffers'
// home: src/discover/discover-steps.ts needs to land on the *exact* module
// instance a step file's own registrations/World/hooks go into (registry.ts
// and world.ts's own headers explain why), by importing each one directly
// via its own relative path — that only converges on the same instance as
// this file's own imports if this file does nothing to any of their exports
// beyond re-exporting them verbatim (no wrapping, no re-instantiation).
export { Given, When, Then, defineParameterType, setDefaultTimeout } from "./registry.js";
export {
  World,
  setWorldConstructor,
  type WorldConstructor,
  type WorldConstructorParams,
  type IWorldOptions,
} from "./world.js";
export {
  Before,
  After,
  AfterStep,
  type HookFn,
  type HookOptions,
  type HookParameter,
  type ITestCaseHookParameter,
} from "./hooks.js";
export { BeforeAll, AfterAll, type RunHookFn, type RunHookOptions } from "./run-hooks.js";
export { DataTable } from "./data-table.js";
// World's own declaration surface — "measurement is always on, declaration
// is opt-in".
export { defineWorld, type InferWorldFields } from "./define-world.js";
// `Status`: the compat audit counted `result.status === Status.FAILED`-style
// glue 3 times, across 3 real-world
// repos — an ESM named import missing this one name drops that whole
// `import { ... }` statement's file. Re-exports `@cucumber/messages`'s own
// `TestStepResultStatus` verbatim (a real string enum, `PASSED = "PASSED"`
// etc.) rather than defining a second one: `HookParameter.result.status`
// (src/compat/hooks.ts) already returns that exact enum's own string values
// independently of this re-export, so the re-export alone is enough to make
// `result.status === Status.FAILED` both import and compare correctly.
// `Status.PENDING`/`SKIPPED`/`UNDEFINED`/`AMBIGUOUS`/`UNKNOWN` can never
// actually match a `HookParameter.result.status` under nukadoko — there is
// no pending/skipped concept here (a step/hook returning either string fails
// loudly instead, src/run/run-scenario.ts's `pendingOrSkippedMessage`) and
// undefined/ambiguous are step-match outcomes, never a hook's own result. A
// branch comparing against
// one of those five is not a bug in migrated glue; it is a branch nukadoko
// simply never takes, which is the correct behavior, not a gap to close.
export { TestStepResultStatus as Status } from "@cucumber/messages";
