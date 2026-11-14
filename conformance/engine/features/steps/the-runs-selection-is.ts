import { defineStep, z } from "nukadoko";
import nukaRuns from "./nuka-runs.ts";

export default defineStep({
  description: "The --json envelope's selection: full when every scenario of each targeted file ran, partial when a line or a tag left one out",
  pattern: "the run's selection is {selection:string}",
  args: z.object({
    selection: z.string().describe("full or partial"),
    actual: nukaRuns.returns.shape.selection,
  }),
  from: { actual: [nukaRuns, "selection"] },
  claims: [{ actual: "actual", compare: "equal", expected: "selection" }],
});
