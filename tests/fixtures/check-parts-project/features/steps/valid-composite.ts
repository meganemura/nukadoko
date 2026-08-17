import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createProject from "./create-project.js";
import inviteMember from "./invite-member.js";

// A genuinely correct `parts` declaration (docs/spec.md "Parts"'s own
// example) — the control case proving `nuka check`'s three new part-*
// findings stay silent for a step that has nothing wrong with it, even
// sitting in the same vocabulary as this fixture's several broken steps.
export default defineStep({
  pattern: "a project {name:string} has {email:string} as a member",
  description: "Create a project and invite one member into it",
  args: z.object({ name: z.string(), email: z.string() }),
  returns: z.object({ projectId: z.string(), memberId: z.string() }),
  parts: [createProject, inviteMember],
  async run({ call }, args) {
    const project = await call(createProject, { name: args.name });
    const member = await call(inviteMember, { projectId: project.id, email: args.email });
    return { projectId: project.id, memberId: member.memberId };
  },
});
