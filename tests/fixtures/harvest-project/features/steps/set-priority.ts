import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `priority` is required, has no capture, and no `from` — and its value is
// a number, which no docstring/table can carry (both bind to a string or a
// string[][]). This is the "neither capture, chain, nor attachment" case
// (docs/spec.md "Harvesting"): `nuka harvest` still writes the line, with
// a comment naming the key `nuka check` will refuse as
// unfillable-required-key.
export default defineStep({
  pattern: "a priority is set for project {projectId:string}",
  description: "Set a numeric priority on a project",
  args: z.object({ projectId: z.string(), priority: z.number() }),
  returns: z.object({ projectId: z.string(), priority: z.number() }),
  async run({}, args) {
    return { projectId: args.projectId, priority: args.priority };
  },
});
