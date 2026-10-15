import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The planted bug: the second add of a sequence is lost.
export default defineStep({
  pattern: "{n:int} is added",
  description: "Adds n to the counter and returns the total",
  args: z.object({ n: z.number().int() }),
  returns: z.object({ total: z.number().int() }),
  mutates: true,
  async run({ counter }: any, args) {
    counter.adds += 1;
    if (counter.adds !== 2) counter.total += args.n;
    return { total: counter.total };
  },
});
