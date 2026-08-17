import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `rows` is required and has no capture, no `from` — the table-shaped
// counterpart to set-note.ts's own docstring case (docs/spec.md "Typed
// steps": "tables as string[][]").
export default defineStep({
  pattern: "rows are imported for project {projectId:string}",
  description: "Import a table of rows for a project",
  args: z.object({ projectId: z.string(), rows: z.array(z.array(z.string())) }),
  returns: z.object({ projectId: z.string(), rowCount: z.number() }),
  async run({}, args) {
    return { projectId: args.projectId, rowCount: args.rows.length };
  },
});
