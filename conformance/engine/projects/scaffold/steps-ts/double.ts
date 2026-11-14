import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Double a number",
  pattern: "I double {n:int}",
  args: z.object({ n: z.number().describe("The number to double") }),
  returns: z.object({ doubled: z.number().describe("Twice the number") }),
  // Computes in memory only.
  mutates: false,
  run({}, { n }) {
    // 1000 stands for a number the program under test cannot take.
    if (n === 1000) throw new Error("too big");
    return { doubled: n * 2 };
  },
});
