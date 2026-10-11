import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  description: "Echo a name",
  args: z.object({ name: z.string() }),
  returns: z.object({ name: z.string() }),
  mutates: false,
  async run({}, args) {
    return { name: args.name };
  },
});
