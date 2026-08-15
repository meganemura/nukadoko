import { defineConfig, defineFixtures } from "./nukadoko-shim.js";

// `needs_browser` must be `true`
// for a step that only reaches `page` *through* a fixture, never directly —
// `loggedIn` here destructures `page` itself; `via-logged-in-step.ts`
// destructures only `loggedIn`. Also exercises `nuka tend`'s two new
// findings (scope item 9): `fixtureReachesUnused` never touched by any
// step, `loggedIn` reported by `fixture-touches-app` since it reaches
// `page`.
export default defineConfig({
  fixtures: defineFixtures({
    loggedIn: async ({ page }, use) => {
      await page.goto("about:blank");
      await use(page);
    },
    fixtureReachesUnused: async ({}, use) => {
      await use(1);
    },
  }),
});
