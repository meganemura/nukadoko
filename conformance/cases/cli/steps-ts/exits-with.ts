import { defineStep, z } from "nukadoko";
import runTally from "./run-tally.ts";

export default defineStep({
  description: "The process exit code is exactly this",
  pattern: "it exits with {code:int}",
  args: z.object({
    code: z.number().describe("The expected exit code"),
    exitCode: runTally.returns.shape.exitCode,
  }),
  from: {
    exitCode: [runTally, "exitCode"],
  },
  claims: [{ actual: "exitCode", compare: "equal", expected: "code" }],
});
