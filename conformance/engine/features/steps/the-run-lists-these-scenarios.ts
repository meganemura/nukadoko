import { defineStep, z } from "nukadoko";
import nukaRuns from "./nuka-runs.ts";

export default defineStep({
  description: "The --json envelope's scenarios, one per line as feature:line environment status, are exactly the docstring",
  pattern: "the run lists these scenarios",
  args: z.object({
    expected: z.string().describe("One line per scenario execution, in run order"),
    scenarios: nukaRuns.returns.shape.scenarios,
  }),
  from: { scenarios: [nukaRuns, "scenarios"] },
  claims: [{ actual: "scenarios", view: "text", compare: "equal", expected: "expected" }],
});
