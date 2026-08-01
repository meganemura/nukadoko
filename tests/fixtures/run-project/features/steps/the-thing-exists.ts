import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Bound in Then position in passing.feature: `mutates: false`, so it is not
// rejected by the Then-position enforcement (this task's spec, decision 3).
export default defineStep({
  pattern: "the thing {name:string} exists",
  description: "Check that a thing exists",
  args: z.object({ name: z.string() }),
  returns: z.object({ found: z.boolean() }),
  mutates: false,
  async run() {
    return { found: true };
  },
});
