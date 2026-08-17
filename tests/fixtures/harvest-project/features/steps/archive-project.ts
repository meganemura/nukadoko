import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";

// The chain-consumer side: `projectId` is declared `from`
// create-project's own `id`, and the pattern captures nothing for it — the
// case `nuka harvest` must leave blank on the line (docs/spec.md
// "Harvesting").
export default defineStep({
  pattern: "the project is archived",
  description: "Archive the project named by projectId (from create-project)",
  args: z.object({ projectId: z.string() }),
  returns: z.object({ archived: z.boolean(), projectId: z.string() }),
  from: { projectId: [createProject, "id"] },
  async run({}, args) {
    return { archived: true, projectId: args.projectId };
  },
});
