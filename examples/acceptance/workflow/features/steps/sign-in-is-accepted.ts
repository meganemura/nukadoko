import { defineStep, z } from "nukadoko";
import assert from "node:assert/strict";
import signIn from "./sign-in.ts";

export default defineStep({
  description: "The last sign-in attempt was accepted",
  pattern: "the sign-in is accepted",
  args: z.object({ accepted: signIn.returns.shape.accepted, reason: signIn.returns.shape.reason }),
  from: { accepted: [signIn, "accepted"], reason: [signIn, "reason"] },
  mutates: false,
  run({}, { accepted, reason }) {
    assert.equal(accepted, true, `sign-in: expected accepted, got refused because "${reason}"`);
  },
});
