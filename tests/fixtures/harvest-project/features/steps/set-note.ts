import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `note` is required and has no capture in the pattern, no `from` — the
// one args key a docstring can bind to (docs/spec.md "Typed steps": "a
// data table or docstring ... binds to the one required args key the
// named captures left unconsumed").
export default defineStep({
  pattern: "a note is set for project {projectId:string}",
  description: "Attach a note to a project (from a docstring)",
  args: z.object({ projectId: z.string(), note: z.string() }),
  returns: z.object({ projectId: z.string(), note: z.string() }),
  async run({}, args) {
    return { projectId: args.projectId, note: args.note };
  },
});
