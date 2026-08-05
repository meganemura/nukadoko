import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";
import importProject from "./import-project.js";

// The consumer side of `from`'s multiple-candidate form (m7a-from-
// alternatives task spec; docs/spec.md "Chaining steps": "A key may name
// more than one possible producer") — `projectId` may come from either
// producer, and which one actually supplies it is a per-scenario fact the
// feature file states by which one it binds earlier, never a priority this
// step declares.
export default defineStep({
  pattern: "the project is archived",
  description: "Archive the project created or imported earlier in this scenario",
  args: z.object({ projectId: z.string() }),
  returns: z.object({ archived: z.boolean(), projectId: z.string() }),
  from: { projectId: [[createProject, "id"], [importProject, "projectId"]] },
  async run({}, args) {
    return { archived: true, projectId: args.projectId };
  },
});
