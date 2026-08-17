import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A second, independent capture-only step (an `{int}` capture this time) —
// exercises the "straightforward sequence, line order preserved" case
// alongside create-project.ts, and int's own bare-number rendering.
export default defineStep({
  pattern: "there are {count:int} items in the cart",
  description: "Record how many items are in the cart",
  args: z.object({ count: z.number() }),
  returns: z.object({ total: z.number() }),
  async run({}, args) {
    return { total: args.count };
  },
});
