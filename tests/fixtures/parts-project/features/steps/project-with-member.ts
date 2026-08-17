import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import inviteMember from "./invite-member.js";

// The composite: splits a scenario-facing action into a call on a part,
// without the split showing up as a second entry in any feature — the whole
// point docs/spec.md "Parts" describes. CLI-only vocabulary (no `pattern`):
// this fixture is about `call`'s own mechanics, not scenario binding.
export default defineStep({
  description: "Create a project and invite one member into it, through a declared part",
  args: z.object({ email: z.string() }),
  returns: z.object({ memberId: z.string() }),
  parts: [inviteMember],
  async run({ call }, args) {
    const member = await call(inviteMember, { projectId: "p_1", email: args.email });
    return { memberId: member.memberId };
  },
});
