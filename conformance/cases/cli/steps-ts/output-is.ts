import { defineStep, z } from "nukadoko";
import runTally from "./run-tally.ts";

export default defineStep({
  description: "stdout is exactly the docstring, ignoring a trailing newline",
  pattern: "the output is",
  args: z.object({
    expected: z.string().describe("The expected stdout, verbatim"),
    stdout: runTally.returns.shape.stdout,
  }),
  from: {
    stdout: [runTally, "stdout"],
  },
  // The program ends its output with a newline that the feature line does not show.
  claims: [{ actual: "stdout", view: "text", compare: "equal", expected: "expected" }],
});
