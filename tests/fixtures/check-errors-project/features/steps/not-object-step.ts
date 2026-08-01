import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Triggers: args-not-object (a pattern-bearing step's args must be a
// z.object).
export default defineStep({
  pattern: "a bare thing {value:string}",
  description: "d",
  args: z.string(),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
