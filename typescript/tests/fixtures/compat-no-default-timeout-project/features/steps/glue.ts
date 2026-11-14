import { Given } from "../../nukadoko-compat-shim.js";

// No `setDefaultTimeout` call anywhere in this project (unlike ../../
// compat-default-timeout-project) — this step declares no `{ timeout }` of
// its own either, so it must run unbounded. A 50ms sleep is unremarkable
// but non-instant, distinguishing
// "actually ran to completion" from "would have failed instantly against
// some hidden default".

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Given("a legacy step with no timeout at all runs and takes a little while", async function () {
  await sleep(50);
});
