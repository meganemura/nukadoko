import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Count to a number",
  pattern: "I count to {n:int}",
  patterns: ["I count"],
  args: z.object({ n: z.number().describe("The number to count to") }),
  // Counts in memory only.
  mutates: false,
  run() {
    return {};
  },
});
