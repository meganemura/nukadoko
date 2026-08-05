import { After, AfterStep, Before } from "../../nukadoko-compat-shim.js";

// Before hook: touches the browser exactly once, before either step runs
// (p3d-hook-trace task spec test item 1) — its own trace chunk must show
// only this navigation, never a step's or AfterStep's.
Before(async function () {
  const page = await this.openPage();
  await page.goto("data:text/html,before-hook");
});

// After hook: deliberately never touches the browser at all — proves the
// negative case (this task's spec test item 3: "ブラウザに触れない hook に
// trace が出ないこと").
After(function () {
  this.log("after:ran");
});

// AfterStep hook: runs once per executed step (t7-compat-status-afterstep
// task spec), touching the browser each time — proves 2 separate chunks for
// 2 executed steps (this task's spec test item 2), each showing only that
// invocation's own navigation, not either step's (test item 5).
AfterStep(async function () {
  const page = await this.openPage();
  await page.goto("data:text/html,after-step-hook");
});
