import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The other of `archive-project.ts`'s two mutually exclusive producers
// (m7a-from-alternatives task spec) — a scenario imports an existing project
// instead of creating one. Deliberately returns its id under a different key
// name than create-project.ts's own ("projectId", not "id") — docs/spec.md
// "Chaining steps"' own example uses exactly this asymmetry to show that a
// candidate's own returns key can differ from another candidate's.
export default defineStep({
  pattern: "a project {name:string} is imported",
  description: "Import an existing project and return its id and name",
  args: z.object({ name: z.string() }),
  returns: z.object({ projectId: z.string(), name: z.string() }),
  async run({}, args) {
    return { projectId: `p_${args.name}`, name: args.name };
  },
});
