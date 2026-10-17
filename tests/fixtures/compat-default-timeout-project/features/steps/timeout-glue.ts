import { Given } from "../../nukadoko-compat-shim.js";

// `setDefaultTimeout` (registered in
// ../support/set-default-timeout.ts, resolving to 20ms after two calls —
// last one wins) only ever applies to a step that declares no `{ timeout }`
// of its own; a step's own declared timeout always wins over the default.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Settles only when tests/compat-run-scope.test.ts releases it, after the
// run has returned. A run that waited for this step instead of cutting it
// off at a timeout would never return, however fast or slow the machine.
function heldUntilReleased(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const held = (g.__nukadokoHeldSteps as Array<() => void> | undefined) ?? [];
  g.__nukadokoHeldSteps = held;
  return new Promise((resolve) => held.push(resolve));
}

// No `{ timeout }` at all, so it falls back to the project's own default (20ms).
// It never settles on its own, so only that timeout can end it.
Given("a legacy step with no own timeout that sleeps a while", async function () {
  await heldUntilReleased();
});

// Own `{ timeout }` (5000ms) is far larger than the project's own default
// (20ms) and wins over it — this step's 50ms sleep finishes comfortably
// inside its own timeout, so it passes; if the small default were applied
// instead, it would fail at ~20ms.
Given(
  "a legacy step whose own timeout overrides the default and sleeps briefly",
  { timeout: 5000 },
  async function () {
    await sleep(50);
  },
);
