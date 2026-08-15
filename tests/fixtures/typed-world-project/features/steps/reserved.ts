import { Then } from "../../nukadoko-compat-shim.js";
import type { CustomWorld } from "../support/world.js";

// `attach` is typed `readonly` on `World` itself — the cast is what lets
// this compile; the run-time guard (src/compat/world-instrumentation.ts)
// is what actually rejects it, since a reserved-key overwrite is a run-time
// error.
Then("attach is reassigned", function (this: CustomWorld) {
  (this as unknown as { attach: unknown }).attach = () => {};
});
