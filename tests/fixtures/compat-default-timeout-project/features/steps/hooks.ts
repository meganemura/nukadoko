import { Before, When } from "../../nukadoko-compat-shim.js";

// Same default-timeout-vs-own-timeout coverage as ../steps/timeout-glue.ts,
// for a scenario-level Before hook instead of a step (m22-compat-run-scope
// task spec, item 1: "適用先は compat の step とフックの両方").

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A trivial step for hook-only scenarios below — none of them care what a
// step does, only what runs around it.
When("a no-op legacy step runs", function () {});

// No own `{ timeout }` — falls back to the project's own default (20ms),
// tagged so it only applies to its own dedicated scenario.
Before({ tags: "@hook-default-timeout" }, async function () {
  await sleep(500);
});

// Own `{ timeout }` (5000ms) overrides the default — its own 50ms sleep
// finishes well inside it, so the scenario passes.
Before({ tags: "@hook-own-timeout", timeout: 5000 }, async function () {
  await sleep(50);
});
