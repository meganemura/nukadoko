import type { FixtureDefinition } from "./types.js";

// Responsibility: the one identity helper that gives a config author's
// fixture object literal full type inference under `strict` TypeScript
// (P5 task spec, scope item 2) — the same "give a literal a name, validate
// nothing" role src/config/define-config.ts's own `defineConfig` plays for
// the whole config object. Validation (`auto: true`, an unknown fixture
// name, a cycle, a scope violation, `page-override-unowned`, ...) all
// happens later, over the *resolved* config (src/step/validate-fixtures.ts)
// — the same defineConfig/loadConfig split this mirrors.
//
// Why this needs to exist at all (measured): a plain
//
//   export const fixtures = { tenant: async ({ request }, use) => {...} };
//
// loses contextual typing the moment it's written as a top-level `export
// const` rather than an inline call argument — `request` and `use` both
// come back implicitly `any` and fail to compile under `strict`. Passing
// the exact same object literal through this generic identity function
// instead keeps it inline from TypeScript's own point of view (the object
// literal *is* the call's own argument), so ordinary contextual typing
// applies and both parameters come out fully typed — `request` as
// `APIRequestContext`, `use` as `UseFn` — with no annotation the config
// author has to write by hand.
export function defineFixtures<T extends Record<string, FixtureDefinition>>(fixtures: T): T {
  return fixtures;
}
