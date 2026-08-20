import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A plain, always-succeeding step: the ok path, and (given the wrong args)
// the args-validation-failure path.
export default defineStep({
  description: "Return args.value unchanged",
  args: z.object({ value: z.string() }),
  returns: z.object({ value: z.string() }),
  mutates: false,
  async run({}, args) {
    return { value: args.value };
  },
});
