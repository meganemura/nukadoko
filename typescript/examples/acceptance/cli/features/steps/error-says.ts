import { defineStep, z } from "nukadoko";
import runTally from "./run-tally.ts";

export default defineStep({
  description: "The first line of stderr is exactly this",
  pattern: "the error says {text:string}",
  args: z.object({
    text: z.string().describe("The expected first line of stderr"),
    stderr: runTally.returns.shape.stderr,
  }),
  from: {
    stderr: [runTally, "stderr"],
  },
  claims: [{ actual: "stderr", view: "lines", at: "0", compare: "equal", expected: "text" }],
});
