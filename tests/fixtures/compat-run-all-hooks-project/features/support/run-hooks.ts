import { AfterAll, BeforeAll } from "../../nukadoko-compat-shim.js";

// Captured on `globalThis`, not exported (same reasoning as
// tests/fixtures/module-identity-project/features/steps/consumer.ts's own
// header): the test reading this capture runs under vitest's own module
// system, not the tsx registration discoverSteps() loads this file through,
// so a plain named export here would not be reachable the way the test
// needs it to be. tests/compat-run-scope.test.ts resets this array before
// each of its own `it()`s and reads it back after `runCli` returns, to
// prove each hook below ran exactly once (not once per scenario) and in
// what order.
function record(label: string): void {
  const g = globalThis as Record<string, unknown>;
  const log = (g.__nukadokoRunAllHooksLog as string[] | undefined) ?? [];
  log.push(label);
  g.__nukadokoRunAllHooksLog = log;
}

// Runs once, before either scenario in ../two-scenarios.feature (m22-
// compat-run-scope task spec, item 2: "run 全体で1回").
BeforeAll(function () {
  record("beforeAll");
});

// Two AfterAll registrations, on purpose: proves both "every registration
// is attempted regardless of an earlier one's own failure" (this task's
// spec: "全て試行し") and the LIFO order src/cli/run.ts's own header commits
// to (matching src/run/run-scenario.ts's own After-hook loop) — registered
// first, so it must run *second* (afterAll-B, registered after it, unwinds
// first).
AfterAll(function () {
  record("afterAll-A");
});

// Registered second, so it must run *first* — and throws, proving AfterAll
// failure still lets the exit code go non-zero without stopping
// afterAll-A from still being attempted afterward.
AfterAll(function () {
  record("afterAll-B");
  throw new Error("afterAll-B failed on purpose");
});
