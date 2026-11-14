import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";

// `count` fails args validation for a reason that has nothing to do with
// `projectId` (never captured, never bound, but genuinely optional so no
// static or runtime check ever flags it on its own). Proves from's own
// hint stays silent when the failure it's attached to is not actually
// about the still-missing key: fromInjectionHint only ever speaks up for a
// key zod itself flagged.
export default defineStep({
  pattern: "the project is filed, with an unrelated failure on count {count:string}",
  description: "count fails its own schema; projectId is unfilled but never the reason this line fails",
  args: z.object({ projectId: z.string().optional(), count: z.number() }),
  returns: z.object({ filed: z.boolean() }),
  from: { projectId: [createProject, "id"] },
  async run() {
    return { filed: true };
  },
});
