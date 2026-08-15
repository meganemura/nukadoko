import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";
import importProject from "./import-project.js";

// An *optional* key with
// several candidate producers is silent when none is bound (m6b-from-check's
// own rule, unaffected by having more than one candidate) but still errors
// when two or more are bound earlier — docs/spec.md "Chaining steps": "Two
// or more of a key's listed producers bound earlier is an error whether the
// key is required or optional".
export default defineStep({
  pattern: "the project is filed with an optional note",
  description: "File a project note; projectId is optional and comes from from when available",
  args: z.object({ projectId: z.string().optional() }),
  returns: z.object({ filed: z.boolean() }),
  from: { projectId: [[createProject, "id"], [importProject, "projectId"]] },
  async run() {
    return { filed: true };
  },
});
