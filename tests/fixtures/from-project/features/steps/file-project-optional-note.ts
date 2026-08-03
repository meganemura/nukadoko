import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";

// m6b-from-check task spec acceptance case: an *optional* `from` key with no
// earlier upstream is silent, on purpose (docs/spec.md "Chaining steps":
// "An optional key with neither is silent — the schema already said the
// value may be absent"). `projectId` is never captured by this step's own
// pattern and is declared optional in `args`, so a scenario that never binds
// `createProject` at all must produce no order-check finding for it.
export default defineStep({
  pattern: "the project is filed with an optional note",
  description: "File a project note; projectId is optional and comes from from when available",
  args: z.object({ projectId: z.string().optional() }),
  returns: z.object({ filed: z.boolean() }),
  from: { projectId: [createProject, "id"] },
  async run() {
    return { filed: true };
  },
});
