import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createOwner from "./create-owner.js";
import createProject from "./create-project.js";

// Two `from` keys, two distinct upstreams (m6c-do-use task spec's own "--use
// twice, two different upstream keys both fill" test) — `projectId` and
// `ownerId` each have to come from a different receipt's `result`.
export default defineStep({
  description: "Archive the project and record its owner (from create-project/create-owner, or --use)",
  args: z.object({ projectId: z.string(), ownerId: z.string() }),
  returns: z.object({ archived: z.boolean(), projectId: z.string(), ownerId: z.string() }),
  from: { projectId: [createProject, "id"], ownerId: [createOwner, "id"] },
  async run(_ctx, args) {
    return { archived: true, projectId: args.projectId, ownerId: args.ownerId };
  },
});
