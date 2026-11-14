import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The other half of the ambiguous match — see ambiguous-a.ts's own comment.
export default defineStep({
  pattern: "an ambiguous widget exists",
  description: "The other half of an ambiguous match, with its own unfillable required key",
  args: z.object({ serialB: z.string() }),
  returns: z.object({ serialB: z.string() }),
  async run({}, args) {
    return { serialB: args.serialB };
  },
});
