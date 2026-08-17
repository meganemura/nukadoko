import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import sendInvite from "./send-invite.js";

// A part that itself calls a part (send-invite), and also hits the test
// server directly — the combination project-with-member.ts's own test
// reads two facts off: nesting (calls[0].calls[0]) and that a part's own
// HTTP call is counted on the *calling* step's own `observed`, not a
// separate tally (docs/spec.md "Parts": "observed ... all stay the calling
// step's").
export default defineStep({
  description: "Invite a member: POST to the server, then call send-invite, a part of its own",
  args: z.object({ projectId: z.string(), email: z.string() }),
  returns: z.object({ memberId: z.string() }),
  parts: [sendInvite],
  async run({ call, request }, args) {
    await request.post("/ok");
    const { sent } = await call(sendInvite, { email: args.email });
    return { memberId: sent ? `m_${args.email}` : "" };
  },
});
