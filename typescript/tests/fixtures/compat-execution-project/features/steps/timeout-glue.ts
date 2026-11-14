import { Given, When } from "../../nukadoko-compat-shim.js";

// A compat step's own `{ timeout }` is enforced: the first step below
// never settles on its own, so only its 20ms timeout can end it.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Settles only when tests/compat-execution.test.ts releases it, after the
// run has returned. A run that waited for this step instead of cutting it
// off at its timeout would never return, however fast or slow the machine.
function heldUntilReleased(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const held = (g.__nukadokoHeldSteps as Array<() => void> | undefined) ?? [];
  g.__nukadokoHeldSteps = held;
  return new Promise((resolve) => held.push(resolve));
}

Given("a legacy step that outlives its own timeout", { timeout: 20 }, async function () {
  await heldUntilReleased();
});

// 12345ms is a distinctive, otherwise-unlikely-to-collide timeout value
// (tests/compat-execution.test.ts spies on `setTimeout`/`clearTimeout` and
// greps for this exact delay to find *this* step's own race timer among
// whatever else in the same `nuka run` invocation also calls `setTimeout`).
// Finishes in ~1ms, nowhere near it — proves the race timer set up to
// enforce that timeout is cleared right away on success, not left pending
// for the full 12345ms (the timer must always be
// cleared).
Given("a legacy step that finishes well within its own timeout", { timeout: 12_345 }, async function () {
  await sleep(1);
});

When("the next legacy step runs", function () {});
