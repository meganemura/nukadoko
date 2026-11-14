import { defineStep, z } from "nukadoko";
import nukaRuns from "./nuka-runs.ts";

export default defineStep({
  description: "nuka verdict's judged: missing, stale, judged, or unknown",
  pattern: "the verdict judged {judged:string}",
  args: z.object({
    judged: z.string().describe("What the verdict says the newest run judged"),
    actual: nukaRuns.returns.shape.judged,
  }),
  from: { actual: [nukaRuns, "judged"] },
  claims: [{ actual: "actual", compare: "equal", expected: "judged" }],
});
