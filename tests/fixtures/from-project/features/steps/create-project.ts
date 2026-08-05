import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The chain's producer side (m6a-from-core task spec) — a plain,
// deterministic step with no network/browser at all, so this fixture's
// `from` tests are about the injection mechanism itself.
export default defineStep({
  pattern: "a project {name:string} is created",
  description: "Create a project and return its id and name",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  async run({}, args) {
    return { id: `p_${args.name}`, name: args.name };
  },
});
