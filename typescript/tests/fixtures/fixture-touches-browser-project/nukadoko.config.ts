import { defineConfig, defineFixtures } from "./nukadoko-shim.js";

// `needs_browser` must be `true`
// for a step that only reaches `page` *through* a fixture, never directly —
// `loggedIn` here destructures `page` itself; `via-logged-in-step.ts`
// destructures only `loggedIn`. `fixtureReachesUnused` is required by no
// step, so it is the `fixture-unused` note's case.
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
