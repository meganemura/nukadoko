import { Before } from "nukadoko/compat";

// The only other compat glue in this otherwise all-native fixture project
// besides hook-fails.ts (mixed.feature) -- deliberately, same reason that
// file already gives: a Before hook is not reachable any other way from a
// project built on native `defineStep` (nukadoko's own top-level exports
// carry no Before/After; only nukadoko/compat does).
//
// Scoped to @browser-evidence so it never touches this project's other
// three features, keeping their own run time unaffected by browser
// startup. `page.goto`,
// never `page.setContent`: a `goto` call is what shows up as an action in
// the trace (visits-noisy-data-url.ts's own header explains why in full);
// this hook only needs enough of one to prove that a hook touching the
// browser gets its own fixture, with its own trace, in the Allure report --
// the same way a step already does.
Before({ tags: "@browser-evidence" }, async function () {
  const page = await this.openPage();
  await page.goto("data:text/html,before-hook");
});
