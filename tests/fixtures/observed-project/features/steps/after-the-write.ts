import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Follows the write in then-position.feature's second scenario. Because the
// declaration is trusted over the measurement, the preceding step's
// declared-non-mutating write never fails the scenario, so this step
// actually runs.
export default defineStep({
  pattern: "a step after the write also runs",
  description: "Trivial step that now actually executes, since the write above no longer fails",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
