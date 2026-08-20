import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The `--use` producer side: creates a thing and returns its id, for
// use-thing.ts's own `from` to draw on.
export default defineStep({
  description: "Create a thing and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string() }),
  mutates: true,
  async run({}, args) {
    return { id: `t_${args.name}` };
  },
});
