import { z } from "zod";
import createProject from "./create-project.js";
import { defineStep } from "../../nukadoko-shim.js";

// A genuinely correct `from` chain — the control case proving `nuka check`'s
// new structural check stays silent for a step that has nothing wrong with
// it, even sitting in the same
// vocabulary as this fixture's two broken steps.
export default defineStep({
  pattern: "the project is archived",
  description: "Archive the project created earlier",
  args: z.object({ projectId: z.string() }),
  returns: z.object({ archived: z.boolean() }),
  from: { projectId: [createProject, "id"] },
  async run() {
    return { archived: true };
  },
});
