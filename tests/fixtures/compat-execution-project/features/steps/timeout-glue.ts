import { Given, When } from "../../nukadoko-compat-shim.js";

// m21b-compat-execution task spec, item 2: a compat step's own `{ timeout }`
// is now actually enforced (previously kept but never applied). The first
// step below sleeps well past its own timeout — the point is that
// `{ timeout }` cuts the wait short at 20ms, not that the 500ms sleep itself
// ever completes (the honest limitation this task's spec, item 2 documents:
// the sleep keeps running in the background regardless).

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Outlives its own 20ms timeout — always fails, promptly, at ~20ms, never
// at 2000ms (tests/compat-execution.test.ts asserts the elapsed wall time
// to prove this; the gap to 2000ms is deliberately wide so that ordinary
// process/discovery overhead can never make the assertion flaky).
Given("a legacy step that outlives its own timeout", { timeout: 20 }, async function () {
  await sleep(2000);
});

// 12345ms is a distinctive, otherwise-unlikely-to-collide timeout value
// (tests/compat-execution.test.ts spies on `setTimeout`/`clearTimeout` and
// greps for this exact delay to find *this* step's own race timer among
// whatever else in the same `nuka run` invocation also calls `setTimeout`).
// Finishes in ~1ms, nowhere near it — proves the race timer set up to
// enforce that timeout is cleared right away on success, not left pending
// for the full 12345ms (this task's spec: "タイマーは必ず解除する").
Given("a legacy step that finishes well within its own timeout", { timeout: 12_345 }, async function () {
  await sleep(1);
});

When("the next legacy step runs", function () {});
