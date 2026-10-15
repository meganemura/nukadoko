import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  description: "Count the atoms",
  args: z.object({ count: z.bigint() }),
  returns: z.object({ total: z.bigint() }),
  async run({}, args) {
    return { total: args.count };
  },
});
