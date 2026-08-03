import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A second, independent producer (m6c-do-use task spec) — used two ways: as
// one of two upstreams a single step's `from` names (archive-project-with-
// owner.ts), and, on its own, as a receipt whose step archive-project.ts's
// own `from` never names at all (the "receipt names a step not in `from`"
// error test).
export default defineStep({
  description: "Create an owner and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string() }),
  async run(_ctx, args) {
    return { id: `o_${args.name}` };
  },
});
