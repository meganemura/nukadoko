import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";

// The `--use` consumer side (m6c-do-use task spec) — one `from` key, one
// upstream, mirroring from-project's own archive-project.ts fixture but kept
// separate (see this fixture's nukadoko.config.ts for why).
export default defineStep({
  description: "Archive the project named by projectId (from create-project, or --use)",
  args: z.object({ projectId: z.string() }),
  returns: z.object({ archived: z.boolean(), projectId: z.string() }),
  from: { projectId: [createProject, "id"] },
  async run({}, args) {
    return { archived: true, projectId: args.projectId };
  },
});
