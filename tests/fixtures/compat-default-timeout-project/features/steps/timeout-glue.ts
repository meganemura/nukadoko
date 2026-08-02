import { Given } from "../../nukadoko-compat-shim.js";

// m22-compat-run-scope task spec, item 1: `setDefaultTimeout` (registered in
// ../support/set-default-timeout.ts, resolving to 20ms after two calls —
// last one wins) only ever applies to a step that declares no `{ timeout }`
// of its own; a step's own declared timeout always wins over the default.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// No `{ timeout }` at all — falls back to the project's own default (20ms),
// so this outlives it and fails promptly, never at the full 500ms sleep.
Given("a legacy step with no own timeout that sleeps a while", async function () {
  await sleep(500);
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
