import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A part written only to be called — no `pattern`, so discovery still
// registers it (docs/spec.md "Parts") but no scenario line binds it
// directly. Used by valid-composite.ts, the control case proving a
// genuinely correct `parts` declaration reports nothing.
export default defineStep({
  description: "Create a project and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string() }),
  async run({}, args) {
    return { id: `p_${args.name}` };
  },
});
