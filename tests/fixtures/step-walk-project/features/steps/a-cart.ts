import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a cart with {count:int} items",
  description: "Make a cart that holds count items",
  args: z.object({ count: z.number().describe("How many items the cart holds") }),
  returns: z.object({ items: z.number().describe("How many items the cart holds") }),
  mutates: true,
  async run({}, args) {
    return { items: args.count };
  },
});
