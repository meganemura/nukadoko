import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Always throws: the step_error path, distinct from a schema mismatch.
export default defineStep({
  description: "Always throws",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    throw new Error("thrown on purpose");
  },
});
