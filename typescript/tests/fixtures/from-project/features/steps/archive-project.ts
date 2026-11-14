import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";

// The chain's consumer side, via `from` (docs/
// spec.md "Chaining steps"). Two patterns, deliberately aliased (docs/
// spec.md "Typed steps": aliases are for prose "genuinely interchangeable at
// the args level: same keys, same run() behavior no matter which phrasing
// matched" — both patterns bind the same `projectId` key and this step's own
// `run()` never forks on which one matched): the first never captures
// `projectId` at all (so `from` is what has to fill it), the second captures
// it explicitly (so a capture can be proven to win over `from` in the same
// scenario the first pattern's own test uses `from` for).
export default defineStep({
  pattern: "the project is archived",
  patterns: ["the project {projectId:string} is archived"],
  description: "Archive the project created earlier in this scenario",
  args: z.object({ projectId: z.string() }),
  returns: z.object({ archived: z.boolean(), projectId: z.string() }),
  from: { projectId: [createProject, "id"] },
  async run({}, args) {
    // args.projectId is present or this line was never reached.
    return { archived: true, projectId: args.projectId };
  },
});
