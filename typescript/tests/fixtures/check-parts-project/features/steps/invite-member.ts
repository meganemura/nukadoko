import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The second part valid-composite.ts calls, paired with create-project.ts —
// see that file's own comment.
export default defineStep({
  description: "Invite a member into a project",
  args: z.object({ projectId: z.string(), email: z.string() }),
  returns: z.object({ memberId: z.string() }),
  async run({}, args) {
    return { memberId: `m_${args.email}` };
  },
});
