import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The chain's producer side (m6c-do-use task spec) — a plain, deterministic
// step with no network/browser at all, so this fixture's `--use` tests are
// about the resolution mechanism itself. `name` is required, with no
// default, on purpose: `nuka do create-project --args '{}'` is this
// fixture's own way of producing a real `status: "failed"` receipt (args
// validation failure) for the "a failed receipt passed to --use" test.
export default defineStep({
  description: "Create a project and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string() }),
  async run(_ctx, args) {
    return { id: `p_${args.name}` };
  },
});
