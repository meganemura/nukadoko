import { defineStep, z } from "nukadoko";
import signIn from "./sign-in.ts";

export default defineStep({
  description: "The last sign-in attempt was refused with exactly this reason",
  pattern: "the sign-in is refused because {expected:string}",
  args: z.object({
    expected: z.string().describe("The expected reason"),
    outcome: signIn.returns.shape.outcome,
    reason: signIn.returns.shape.reason,
  }),
  from: { outcome: [signIn, "outcome"], reason: [signIn, "reason"] },
  claims: [
    { actual: "outcome", compare: "equal", expected: { literal: "refused" } },
    { actual: "reason", compare: "equal", expected: "expected" },
  ],
});
