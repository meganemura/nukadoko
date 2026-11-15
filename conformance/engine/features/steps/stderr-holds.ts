import { defineStep, z } from "nukadoko";
import nukaRuns from "./nuka-runs.ts";

export default defineStep({
  description: "What nuka wrote to stderr holds the text the line states",
  pattern: "stderr holds {text:string}",
  args: z.object({
    text: z.string().describe("Text stderr holds somewhere"),
    stderr: nukaRuns.returns.shape.stderr,
  }),
  from: { stderr: [nukaRuns, "stderr"] },
  claims: [{ actual: "stderr", compare: "contains-text", expected: "text" }],
});
