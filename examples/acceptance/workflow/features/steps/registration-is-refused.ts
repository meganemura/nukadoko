import { defineStep, z } from "nukadoko";
import assert from "node:assert/strict";
import register from "./register.ts";

export default defineStep({
  description: "The last registration was refused with exactly this reason",
  pattern: "the registration is refused because {expected:string}",
  args: z.object({
    expected: z.string().describe("The expected reason"),
    accepted: register.returns.shape.accepted,
    reason: register.returns.shape.reason,
  }),
  from: { accepted: [register, "accepted"], reason: [register, "reason"] },
  mutates: false,
  run({}, { expected, accepted, reason }) {
    assert.equal(accepted, false, `registration: expected refused because "${expected}", got accepted`);
    assert.equal(reason, expected, `reason: expected "${expected}", got "${reason}"`);
  },
});
