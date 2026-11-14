import { Before, When } from "../../nukadoko-compat-shim.js";

// The negative default applies to a Before hook the same way it applies to
// a step. Tagged so it only wraps the scenario that asks for it.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

When("a no-op legacy step runs under a negative default", function () {});

Before({ tags: "@hook-negative-default" }, async function () {
  await sleep(80);
});
