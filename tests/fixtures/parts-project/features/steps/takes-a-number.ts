import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A part whose own `args` schema requires a number — calls-part-with-bad-
// args.ts calls this with a string on purpose, to exercise `call`'s own
// args validation.
export default defineStep({
  description: "A part that requires a numeric arg",
  args: z.object({ n: z.number() }),
  returns: z.object({ doubled: z.number() }),
  async run({}, args) {
    return { doubled: args.n * 2 };
  },
});
