import { After, Before, Status, When } from "../../nukadoko-compat-shim.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A trivial step shared by the hook-only feature files below (m21b-compat-
// execution task spec, items 1-5) — none of them care what a step does,
// only what runs around it.
When("a no-op legacy step runs", function () {});

// A step that always fails, used to drive the After hook's own
// `result.status` to "FAILED" (this task's spec, item 3).
When("a legacy step throws for hook coverage", function () {
  throw new Error("boom for hook coverage");
});

// --- item 3: HookParameter reaches every hook, untagged included ---
// Destructuring `{ gherkinDocument, pickle }` here must not crash (real
// glue does exactly this — m2.1-a compat-audit synthesis, 10 sites, 4
// repos) — logged via `this.log` (World's declared channel, m2d-allure-shim
// task spec) so tests/compat-execution.test.ts can read it back off
// `record.hooks[].declared.logs` without needing a data bridge of its own.
Before(function ({ gherkinDocument, pickle, testCaseStartedId, willBeRetried }) {
  this.log(`before:feature=${gherkinDocument.feature?.name}`);
  this.log(`before:pickle=${pickle.name}`);
  this.log(`before:testCaseStartedId=${typeof testCaseStartedId}`);
  this.log(`before:willBeRetried=${willBeRetried}`);
});

// After-only `result` (this task's spec, item 3) — absent for Before,
// present here as `{ status }` using cucumber's own Status string values.
// `after:statusFailedMatches` (t7-compat-status-afterstep task spec, item 1)
// proves `Status.FAILED` isn't just importable but actually equals the same
// string `result.status` carries — real glue's own
// `result.status === Status.FAILED` branch, not a string literal stand-in
// for it.
After(function ({ result }) {
  this.log(`after:result=${result?.status}`);
  this.log(`after:statusFailedMatches=${result?.status === Status.FAILED}`);
});

// --- item 1/2: a per-hook `{ timeout }` override, scoped to @hook-timeout
// so it doesn't slow down every other scenario in this fixture. Registered
// *after* the untagged Before above, so the untagged one still runs (and
// logs) before this one times out and stops the Before phase. ---
Before({ tags: "@hook-timeout", timeout: 20 }, async function () {
  await sleep(500);
});

// --- item 5: a Before hook whose function declares 2 parameters (the
// HookParameter plus an extra) — cucumber-js's own done-callback signal,
// which nukadoko must refuse rather than call. ---
Before({ tags: "@hook-done-callback" }, function (hookParameter, done) {
  done();
});

// --- item 4: a Before hook returning "pending" must fail, not silently
// pass. ---
Before({ tags: "@hook-pending" }, function () {
  return "pending";
});
