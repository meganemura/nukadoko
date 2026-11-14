import { After, AfterStep, Before, Status, When } from "../../nukadoko-compat-shim.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A trivial step shared by the hook-only feature files below — none of
// them care what a step does, only what runs around it.
When("a no-op legacy step runs", function () {});

// A step that always fails, used to drive the After hook's own
// `result.status` to "FAILED".
When("a legacy step throws for hook coverage", function () {
  throw new Error("boom for hook coverage");
});

// --- item 3: HookParameter reaches every hook, untagged included ---
// Destructuring `{ gherkinDocument, pickle }` here must not crash (real
// glue does exactly this — compat-audit synthesis, 10 sites, 4 repos) —
// logged via `this.log` (World's declared channel) so
// tests/compat-execution.test.ts can read it back off
// `record.hooks[].declared.logs` without needing a data bridge of its own.
Before(function (param) {
  const { gherkinDocument, pickle, testCaseStartedId, willBeRetried } = param;
  this.log(`before:feature=${gherkinDocument.feature?.name}`);
  this.log(`before:pickle=${pickle.name}`);
  this.log(`before:testCaseStartedId=${typeof testCaseStartedId}`);
  this.log(`before:willBeRetried=${willBeRetried}`);
  // Before has no step yet, so cucumber-js omits the step fields and
  // `result`/`error`. Logging the keys (not the values) is what fails if
  // a later change starts passing them here.
  this.log(`before:hasPickleStep=${Object.prototype.hasOwnProperty.call(param, "pickleStep")}`);
  this.log(`before:hasTestStepId=${Object.prototype.hasOwnProperty.call(param, "testStepId")}`);
  this.log(`before:hasResult=${Object.prototype.hasOwnProperty.call(param, "result")}`);
  this.log(`before:hasError=${Object.prototype.hasOwnProperty.call(param, "error")}`);
});

// After-only `result` — absent for Before,
// present here as `{ status }` using cucumber's own Status string values.
// `after:statusFailedMatches` proves `Status.FAILED` isn't just importable
// but actually equals the same
// string `result.status` carries — real glue's own
// `result.status === Status.FAILED` branch, not a string literal stand-in
// for it.
function loggedDurationMs(duration: { readonly seconds?: unknown; readonly nanos?: unknown } | undefined): string {
  if (typeof duration?.seconds !== "number" || typeof duration?.nanos !== "number") {
    return "missing";
  }
  return String(duration.seconds * 1000 + duration.nanos / 1_000_000);
}

After(function (param) {
  const { result, error } = param;
  this.log(`after:result=${result?.status}`);
  this.log(`after:statusFailedMatches=${result?.status === Status.FAILED}`);
  this.log(`after:hasError=${Object.prototype.hasOwnProperty.call(param, "error")}`);
  this.log(`after:message=${result?.message ?? "missing"}`);
  this.log(`after:durationMs=${loggedDurationMs(result?.duration)}`);
  this.log(`after:error=${error instanceof Error ? error.message : "missing"}`);
});

// AfterStep reads the step cucumber-js would hand it. Every access is
// guarded so a missing field logs "missing" instead of throwing: a throw
// here would fail scenarios this fixture's other tests expect to pass.
AfterStep(function (param) {
  const { pickleStep, result, testStepId, error } = param;
  this.log(`afterstep:text=${pickleStep?.text ?? "missing"}`);
  this.log(`afterstep:testStepId=${typeof testStepId === "string" ? testStepId : "missing"}`);
  this.log(`afterstep:hasError=${Object.prototype.hasOwnProperty.call(param, "error")}`);
  this.log(`afterstep:message=${result?.message ?? "missing"}`);
  this.log(`afterstep:durationMs=${loggedDurationMs(result?.duration)}`);
  this.log(`afterstep:error=${error instanceof Error ? error.message : "missing"}`);
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
