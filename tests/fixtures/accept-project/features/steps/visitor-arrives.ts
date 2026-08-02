import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a visitor named {name:string} arrives",
  description: "Records that a visitor arrived",
  args: z.object({ name: z.string() }),
  returns: z.object({ name: z.string() }),
  mutates: true,
  async run(_ctx, args) {
    return { name: args.name };
  },
});
