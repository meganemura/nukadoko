import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A {biginteger} capture: the step record stores the bigint as its decimal
// string, so the line must read back to that string and not to a bigint.
export default defineStep({
  pattern: "there are {count:biginteger} atoms",
  description: "Record how many atoms there are",
  args: z.object({ count: z.bigint() }),
  returns: z.object({ total: z.bigint() }),
  async run({}, args) {
    return { total: args.count };
  },
});
