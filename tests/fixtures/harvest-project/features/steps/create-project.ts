import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The plain, capture-only producer side of this fixture's `nuka harvest`
// tests — one named capture, no chain, no attachment.
export default defineStep({
  pattern: "a project {name:string} exists",
  description: "Create a project and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  async run({}, args) {
    return { id: `p_${args.name}`, name: args.name };
  },
});
