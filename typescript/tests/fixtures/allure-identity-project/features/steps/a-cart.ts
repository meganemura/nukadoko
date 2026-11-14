import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a cart with {count:int} items",
  description: "Starts a cart holding the given number of items",
  args: z.object({ count: z.number().int() }),
  returns: z.object({ count: z.number().int() }),
  mutates: false,
  async run({}, { count }) {
    return { count };
  },
});
