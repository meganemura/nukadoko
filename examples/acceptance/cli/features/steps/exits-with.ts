import { defineStep, z } from "nukadoko";
import runTally from "./run-tally.ts";

export default defineStep({
  description: "The process exit code is exactly this",
  pattern: "it exits with {code:int}",
  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.
  args: z.object({
    code: z.number().describe("The expected exit code"),
    exitCode: runTally.returns.shape.exitCode,
  }),
  from: {
    exitCode: [runTally, "exitCode"],
  },
  claims: [{ actual: "exitCode", compare: "equal", expected: "code" }],
});
