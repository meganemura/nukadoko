import { defineStep, z } from "nukadoko";
import nukaRuns from "./nuka-runs.ts";

export default defineStep({
  description: "The --json envelope's refused and failed findings are exactly this one code",
  pattern: "it stops with {code:string}",
  args: z.object({
    code: z.string().describe("The finding's code"),
    stops: nukaRuns.returns.shape.stops,
  }),
  from: { stops: [nukaRuns, "stops"] },
  claims: [{ actual: "stops", compare: "equal", expected: "code" }],
});
