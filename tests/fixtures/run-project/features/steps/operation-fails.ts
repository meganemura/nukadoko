import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Deliberately throws: exercises failing.feature's "step fails, the rest of
// the scenario is skipped" path.
export default defineStep({
  pattern: "the operation fails",
  description: "Always throws to exercise the failed-step-skips-the-rest path",
  args: z.object({}),
  returns: z.object({}),
  mutates: true,
  async run() {
    throw new Error("operation failed on purpose");
  },
});
