import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// See duplicate-a.ts: together these two trigger duplicate-pattern and
// ambiguous-step.
export default defineStep({
  pattern: "duplicate text {b:string}",
  description: "d",
  args: z.object({ b: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
