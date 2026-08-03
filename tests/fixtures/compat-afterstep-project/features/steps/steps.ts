import { AfterStep, Status, When } from "../../nukadoko-compat-shim.js";

// Two trivial passing steps (t7-compat-status-afterstep task spec) — used by
// "two passing steps" to prove AfterStep runs exactly once per executed
// step: the number of times it ran must equal the number of steps executed.
When("a no-op legacy step runs", function () {});
When("a second no-op legacy step runs", function () {});

// Always fails — drives "a failing step skips the rest": the second step
// never executes, so it must get no AfterStep entry at all (this task's
// spec, item 2-3's own regression case).
When("a legacy step throws for afterstep coverage", function () {
  throw new Error("boom for afterstep coverage");
});

// Untagged AfterStep: applies to every scenario in this feature, once per
// executed step (this task's spec, items 2-2/2-3/2-4). Logs that step's own
// `result.status`, both raw and compared against the re-exported `Status`
// enum (this task's spec, item 1), so tests/compat-afterstep.test.ts can
// assert on `record.hooks[].declared.logs` without a data bridge of its own.
AfterStep(function ({ result }) {
  this.log(`afterstep:status=${result?.status}`);
  this.log(`afterstep:statusFailedMatches=${result?.status === Status.FAILED}`);
});

// Tag-filtered AfterStep (this task's spec, item 2-1: same single-@tag
// support Before/After already have) — only for a scenario tagged @slow.
AfterStep({ tags: "@slow" }, function () {
  this.log("afterstep:tagged=ran");
});
