import { defineStep, z } from "nukadoko";
import register from "./register.ts";

export default defineStep({
  description: "The last registration was refused with exactly this reason",
  pattern: "the registration is refused because {expected:string}",
  args: z.object({
    expected: z.string().describe("The expected reason"),
    outcome: register.returns.shape.outcome,
    reason: register.returns.shape.reason,
  }),
  from: { outcome: [register, "outcome"], reason: [register, "reason"] },
  claims: [
    { actual: "outcome", compare: "equal", expected: { literal: "refused" } },
    { actual: "reason", compare: "equal", expected: "expected" },
  ],
});
