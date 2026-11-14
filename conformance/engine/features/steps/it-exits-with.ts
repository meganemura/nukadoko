import { defineStep, z } from "nukadoko";
import nukaRuns from "./nuka-runs.ts";

export default defineStep({
  description: "nuka's exit code is exactly this",
  pattern: "it exits with {code:int}",
  args: z.object({
    code: z.number().describe("The expected exit code"),
    exitCode: nukaRuns.returns.shape.exitCode,
  }),
  from: { exitCode: [nukaRuns, "exitCode"] },
  claims: [{ actual: "exitCode", compare: "equal", expected: "code" }],
});
