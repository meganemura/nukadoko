import { defineStep, z } from "nukadoko";
import assert from "node:assert/strict";
import signIn from "./sign-in.ts";

export default defineStep({
  description: "The last sign-in attempt was refused with exactly this reason",
  pattern: "the sign-in is refused because {expected:string}",
  args: z.object({
    expected: z.string().describe("The expected reason"),
    accepted: signIn.returns.shape.accepted,
    reason: signIn.returns.shape.reason,
  }),
  from: { accepted: [signIn, "accepted"], reason: [signIn, "reason"] },
  mutates: false,
  run({}, { expected, accepted, reason }) {
    assert.equal(accepted, false, `sign-in: expected refused because "${expected}", got accepted`);
    assert.equal(reason, expected, `reason: expected "${expected}", got "${reason}"`);
  },
});
