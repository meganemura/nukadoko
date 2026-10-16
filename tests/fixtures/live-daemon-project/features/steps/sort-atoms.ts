import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  description: "Sort the atoms by the type they arrive as",
  args: z.object({ first: z.union([z.bigint(), z.string()]), second: z.union([z.string(), z.bigint()]) }),
  returns: z.object({ first: z.string(), second: z.string() }),
  async run({}, args) {
    return { first: typeof args.first, second: typeof args.second };
  },
});
