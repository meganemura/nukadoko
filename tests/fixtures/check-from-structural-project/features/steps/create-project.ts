import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The one valid upstream in this fixture — every consumer below either
// chains off it correctly (archive-project.ts, proving a genuine `from`
// chain reports nothing) or names one of its keys wrongly on purpose
// (bad-returns-key-step.ts).
export default defineStep({
  pattern: "a project {name:string} is created",
  description: "Create a project and return its id and name",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  async run(_ctx, args) {
    return { id: `p_${args.name}`, name: args.name };
  },
});
