import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a cart with {count:string} items exists",
  description: "Records that a cart was created with a given item count",
  args: z.object({ count: z.string() }),
  returns: z.object({ items: z.string() }),
  mutates: true,
  async run(_ctx, args) {
    return { items: args.count };
  },
});
