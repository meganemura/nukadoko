import { defineStep, z } from "nukadoko";
import nukaRuns from "./nuka-runs.ts";

export default defineStep({
  description: "Everything nuka printed, stdout then stderr, with each step file written as features/steps/<name>.*, is exactly the docstring",
  pattern: "it prints",
  args: z.object({
    expected: z.string().describe("The text, without its last newline"),
    printed: nukaRuns.returns.shape.printed,
  }),
  from: { printed: [nukaRuns, "printed"] },
  claims: [{ actual: "printed", view: "text", compare: "equal", expected: "expected" }],
});
