import { defineStep, z } from "nukadoko";
import signIn from "./sign-in.ts";

export default defineStep({
  description: "The last sign-in attempt was accepted",
  pattern: "the sign-in is accepted",
  args: z.object({ outcome: signIn.returns.shape.outcome }),
  from: { outcome: [signIn, "outcome"] },
  // "accepted" is a word of the pattern, so the sentence states the value.
  claims: [{ actual: "outcome", compare: "equal", expected: { literal: "accepted" } }],
});
