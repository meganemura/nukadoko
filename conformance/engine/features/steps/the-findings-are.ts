import { defineStep, z } from "nukadoko";
import nukaRuns from "./nuka-runs.ts";

export default defineStep({
  description: "The --json envelope's findings, every severity, are exactly these codes in this order",
  pattern: "the findings are {codes:string}",
  args: z.object({
    codes: z.string().describe("The codes in order, separated by spaces"),
    actual: nukaRuns.returns.shape.codes,
  }),
  from: { actual: [nukaRuns, "codes"] },
  claims: [{ actual: "actual", compare: "equal", expected: "codes" }],
});
