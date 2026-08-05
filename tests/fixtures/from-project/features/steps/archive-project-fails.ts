import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";

// fb3-used-result task spec: same `from` shape as archive-project.ts, but
// always fails after reading the injected value — proves a *failed*
// receipt's `used[].result` carries the upstream's full validated result,
// not merely the `{ receipt, step }` pointer `used` has always carried.
export default defineStep({
  pattern: "the project archival explodes",
  description: "Reads projectId via from, then always fails",
  args: z.object({ projectId: z.string() }),
  returns: z.object({ archived: z.boolean() }),
  from: { projectId: [createProject, "id"] },
  async run({}, args) {
    throw new Error(`archiving project ${args.projectId} exploded on purpose`);
  },
});
