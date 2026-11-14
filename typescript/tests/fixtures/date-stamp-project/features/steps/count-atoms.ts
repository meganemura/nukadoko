import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "there are {count:biginteger} atoms",
  description: "Returns the number of atoms, exactly and coerced",
  args: z.object({ count: z.bigint() }),
  returns: z.object({ total: z.bigint(), coerced: z.coerce.bigint() }),
  mutates: false,
  async run({}, args) {
    return { total: args.count, coerced: args.count };
  },
});
