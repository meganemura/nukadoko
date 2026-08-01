import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Triggers: then-mutates (bound in Then position in features/check.feature,
// but mutates defaults to true).
export default defineStep({
  pattern: "a mutating outcome {x:string}",
  description: "d",
  args: z.object({ x: z.string() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
