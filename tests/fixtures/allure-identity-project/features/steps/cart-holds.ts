import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the cart holds {count:int} items",
  description: "Checks the number of items in the cart",
  args: z.object({ count: z.number().int().nonnegative() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
