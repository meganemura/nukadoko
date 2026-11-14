import { After, AfterStep, Before } from "../../nukadoko-compat-shim.js";

// Before hook: touches the browser exactly once, before either step runs —
// its own trace chunk must show
// only this navigation, never a step's or AfterStep's.
Before(async function () {
  const page = await this.openPage();
  await page.goto("data:text/html,before-hook");
});

// After hook: deliberately never touches the browser at all — proves the
// negative case.
After(function () {
  this.log("after:ran");
});

// AfterStep hook: runs once per executed step, touching the browser each
// time — proves 2 separate chunks for
// 2 executed steps, each showing only that
// invocation's own navigation, not either step's (test item 5).
AfterStep(async function () {
  const page = await this.openPage();
  await page.goto("data:text/html,after-step-hook");
});
