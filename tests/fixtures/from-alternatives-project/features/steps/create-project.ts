import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// One of two mutually exclusive producers for `archive-project.ts`'s own
// `projectId` (m7a-from-alternatives task spec) — a scenario creates a
// project directly, and this is that path.
export default defineStep({
  pattern: "a project {name:string} is created",
  description: "Create a project and return its id and name",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  async run(_ctx, args) {
    return { id: `p_${args.name}`, name: args.name };
  },
});
