import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A second, independent producer — used two ways: as
// one of two upstreams a single step's `from` names (archive-project-with-
// owner.ts), and, on its own, as a step record whose step archive-project.ts's
// own `from` never names at all (the "record names a step not in `from`"
// error test).
export default defineStep({
  description: "Create an owner and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string() }),
  async run({}, args) {
    return { id: `o_${args.name}` };
  },
});
