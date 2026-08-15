import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createOwner from "./create-owner.js";
import createProject from "./create-project.js";

// fb3-used-result task spec: same two-upstream `from` shape as
// archive-project-with-owner.ts, but always fails — proves `--use`'s own
// `used[].result` is populated for every upstream on a failed step record, not
// just the first, exercising the disk-read path (resolve-use.ts) rather than
// a scenario's chain.
export default defineStep({
  description: "Archive the project and owner (from create-project/create-owner, or --use), then always fails",
  args: z.object({ projectId: z.string(), ownerId: z.string() }),
  returns: z.object({ archived: z.boolean() }),
  from: { projectId: [createProject, "id"], ownerId: [createOwner, "id"] },
  async run({}, args) {
    throw new Error(`archiving project ${args.projectId} for owner ${args.ownerId} exploded on purpose`);
  },
});
